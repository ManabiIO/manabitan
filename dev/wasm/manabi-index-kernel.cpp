#include <cstdint>
#include <cstring>
#include <string>
#include <unordered_map>
#include <vector>

#include <emscripten/emscripten.h>

namespace {

uint64_t fnv1a64(const std::string& input, uint64_t seed) {
    uint64_t hash = seed;
    for (unsigned char ch : input) {
        hash ^= static_cast<uint64_t>(ch);
        hash *= 0x100000001b3ULL;
    }
    return hash;
}

uint32_t mixHash32(uint32_t value) {
    value ^= value >> 16;
    value *= 0x7feb352dU;
    value ^= value >> 15;
    value *= 0x846ca68bU;
    value ^= value >> 16;
    return value;
}

void appendU32(std::vector<uint8_t>& output, uint32_t value) {
    output.push_back(static_cast<uint8_t>(value & 0xffU));
    output.push_back(static_cast<uint8_t>((value >> 8) & 0xffU));
    output.push_back(static_cast<uint8_t>((value >> 16) & 0xffU));
    output.push_back(static_cast<uint8_t>((value >> 24) & 0xffU));
}

bool readU32(const uint8_t*& cursor, const uint8_t* end, uint32_t& value) {
    if (cursor + 4 > end) {
        return false;
    }
    value = static_cast<uint32_t>(cursor[0]) |
        (static_cast<uint32_t>(cursor[1]) << 8) |
        (static_cast<uint32_t>(cursor[2]) << 16) |
        (static_cast<uint32_t>(cursor[3]) << 24);
    cursor += 4;
    return true;
}

void appendString(std::vector<uint8_t>& output, const std::string& value) {
    appendU32(output, static_cast<uint32_t>(value.size()));
    output.insert(output.end(), value.begin(), value.end());
}

bool readString(const uint8_t*& cursor, const uint8_t* end, std::string& value) {
    uint32_t size = 0;
    if (!readU32(cursor, end, size)) {
        return false;
    }
    if (cursor + size > end) {
        return false;
    }
    value.assign(reinterpret_cast<const char*>(cursor), size);
    cursor += size;
    return true;
}

struct WasmIndex {
    int bit_count = 8;
    int hash_count = 1;
    std::vector<uint32_t> bloom_bits;
    std::unordered_map<std::string, std::vector<int>> prefix_map;
    std::vector<int> result_buffer;
    std::vector<uint8_t> export_buffer;

    WasmIndex(int bitCount, int hashCount)
        : bit_count(bitCount < 8 ? 8 : bitCount),
          hash_count(hashCount < 1 ? 1 : hashCount),
          bloom_bits(static_cast<size_t>((bit_count + 31) / 32), 0U) {}

    void clear() {
        std::fill(bloom_bits.begin(), bloom_bits.end(), 0U);
        prefix_map.clear();
        result_buffer.clear();
        export_buffer.clear();
    }

    void addBloom(const std::string& key) {
        const uint32_t h1 = static_cast<uint32_t>(fnv1a64(key, 0xcbf29ce484222325ULL) & 0xffffffffULL);
        const uint32_t h2 = static_cast<uint32_t>(fnv1a64(key, 0x9e3779b97f4a7c15ULL) & 0xffffffffULL);
        for (int i = 0; i < hash_count; ++i) {
            const uint32_t h = h1 + static_cast<uint32_t>(i) * (h2 == 0U ? 1U : h2) + static_cast<uint32_t>(i * i);
            const uint32_t index = mixHash32(h) % static_cast<uint32_t>(bit_count);
            bloom_bits[index >> 5] |= (1U << (index & 31));
        }
    }

    bool mightContain(const std::string& key) const {
        const uint32_t h1 = static_cast<uint32_t>(fnv1a64(key, 0xcbf29ce484222325ULL) & 0xffffffffULL);
        const uint32_t h2 = static_cast<uint32_t>(fnv1a64(key, 0x9e3779b97f4a7c15ULL) & 0xffffffffULL);
        for (int i = 0; i < hash_count; ++i) {
            const uint32_t h = h1 + static_cast<uint32_t>(i) * (h2 == 0U ? 1U : h2) + static_cast<uint32_t>(i * i);
            const uint32_t index = mixHash32(h) % static_cast<uint32_t>(bit_count);
            if ((bloom_bits[index >> 5] & (1U << (index & 31))) == 0U) {
                return false;
            }
        }
        return true;
    }

    void add(const std::string& key, int id) {
        if (key.empty()) {
            return;
        }
        addBloom(key);
        for (size_t i = 1; i <= key.size(); ++i) {
            prefix_map[key.substr(0, i)].push_back(id);
        }
    }

    int queryPrefix(const std::string& key) {
        result_buffer.clear();
        if (key.empty()) {
            return 0;
        }
        const auto it = prefix_map.find(key);
        if (it == prefix_map.end()) {
            return 0;
        }
        result_buffer = it->second;
        return static_cast<int>(result_buffer.size());
    }

    bool importState(const uint8_t* data, int size) {
        if (data == nullptr || size <= 0) {
            return false;
        }
        const uint8_t* cursor = data;
        const uint8_t* end = data + size;

        uint32_t magic = 0;
        uint32_t version = 0;
        if (!readU32(cursor, end, magic) || !readU32(cursor, end, version)) {
            return false;
        }
        if (magic != 0x4d584944U || version != 1U) {
            return false;
        }

        uint32_t bitCount = 0;
        uint32_t hashCount = 0;
        uint32_t bloomWordCount = 0;
        if (!readU32(cursor, end, bitCount) || !readU32(cursor, end, hashCount) || !readU32(cursor, end, bloomWordCount)) {
            return false;
        }

        std::vector<uint32_t> importedBloom;
        importedBloom.reserve(bloomWordCount);
        for (uint32_t i = 0; i < bloomWordCount; ++i) {
            uint32_t value = 0;
            if (!readU32(cursor, end, value)) {
                return false;
            }
            importedBloom.push_back(value);
        }

        uint32_t prefixEntryCount = 0;
        if (!readU32(cursor, end, prefixEntryCount)) {
            return false;
        }

        std::unordered_map<std::string, std::vector<int>> importedPrefixMap;
        importedPrefixMap.reserve(prefixEntryCount);

        for (uint32_t i = 0; i < prefixEntryCount; ++i) {
            std::string key;
            if (!readString(cursor, end, key)) {
                return false;
            }
            uint32_t idCount = 0;
            if (!readU32(cursor, end, idCount)) {
                return false;
            }
            std::vector<int> ids;
            ids.reserve(idCount);
            for (uint32_t j = 0; j < idCount; ++j) {
                uint32_t id = 0;
                if (!readU32(cursor, end, id)) {
                    return false;
                }
                ids.push_back(static_cast<int>(id));
            }
            importedPrefixMap.emplace(std::move(key), std::move(ids));
        }

        bit_count = bitCount < 8U ? 8 : static_cast<int>(bitCount);
        hash_count = hashCount < 1U ? 1 : static_cast<int>(hashCount);
        bloom_bits = std::move(importedBloom);
        prefix_map = std::move(importedPrefixMap);
        result_buffer.clear();
        export_buffer.clear();
        return true;
    }

    int exportState() {
        export_buffer.clear();
        export_buffer.reserve(32 + bloom_bits.size() * 4 + prefix_map.size() * 32);

        appendU32(export_buffer, 0x4d584944U);
        appendU32(export_buffer, 1U);
        appendU32(export_buffer, static_cast<uint32_t>(bit_count));
        appendU32(export_buffer, static_cast<uint32_t>(hash_count));
        appendU32(export_buffer, static_cast<uint32_t>(bloom_bits.size()));
        for (uint32_t value : bloom_bits) {
            appendU32(export_buffer, value);
        }

        appendU32(export_buffer, static_cast<uint32_t>(prefix_map.size()));
        for (const auto& [key, ids] : prefix_map) {
            appendString(export_buffer, key);
            appendU32(export_buffer, static_cast<uint32_t>(ids.size()));
            for (int id : ids) {
                appendU32(export_buffer, static_cast<uint32_t>(id));
            }
        }

        return static_cast<int>(export_buffer.size());
    }
};

std::vector<WasmIndex*> g_indexes;

WasmIndex* getIndex(int handle) {
    if (handle < 1 || static_cast<size_t>(handle) > g_indexes.size()) {
        return nullptr;
    }
    return g_indexes[static_cast<size_t>(handle) - 1];
}

std::string toString(const char* key) {
    if (key == nullptr) {
        return std::string();
    }
    return std::string(key);
}

} // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE int manabi_index_create(int bitCount, int hashCount) {
    auto* index = new WasmIndex(bitCount, hashCount);
    g_indexes.push_back(index);
    return static_cast<int>(g_indexes.size());
}

EMSCRIPTEN_KEEPALIVE void manabi_index_destroy(int handle) {
    if (handle < 1 || static_cast<size_t>(handle) > g_indexes.size()) {
        return;
    }
    auto*& slot = g_indexes[static_cast<size_t>(handle) - 1];
    delete slot;
    slot = nullptr;
}

EMSCRIPTEN_KEEPALIVE void manabi_index_clear(int handle) {
    auto* index = getIndex(handle);
    if (index == nullptr) {
        return;
    }
    index->clear();
}

EMSCRIPTEN_KEEPALIVE void manabi_index_add(int handle, const char* key, int id) {
    auto* index = getIndex(handle);
    if (index == nullptr) {
        return;
    }
    index->add(toString(key), id);
}

EMSCRIPTEN_KEEPALIVE int manabi_index_might_contain(int handle, const char* key) {
    const auto* index = getIndex(handle);
    if (index == nullptr) {
        return 0;
    }
    return index->mightContain(toString(key)) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int manabi_index_query_prefix(int handle, const char* key) {
    auto* index = getIndex(handle);
    if (index == nullptr) {
        return 0;
    }
    return index->queryPrefix(toString(key));
}

EMSCRIPTEN_KEEPALIVE int manabi_index_result_ptr(int handle) {
    const auto* index = getIndex(handle);
    if (index == nullptr || index->result_buffer.empty()) {
        return 0;
    }
    return static_cast<int>(reinterpret_cast<intptr_t>(index->result_buffer.data()));
}

EMSCRIPTEN_KEEPALIVE int manabi_index_export(int handle) {
    auto* index = getIndex(handle);
    if (index == nullptr) {
        return 0;
    }
    return index->exportState();
}

EMSCRIPTEN_KEEPALIVE int manabi_index_export_ptr(int handle) {
    const auto* index = getIndex(handle);
    if (index == nullptr || index->export_buffer.empty()) {
        return 0;
    }
    return static_cast<int>(reinterpret_cast<intptr_t>(index->export_buffer.data()));
}

EMSCRIPTEN_KEEPALIVE int manabi_index_import(int handle, const uint8_t* data, int size) {
    auto* index = getIndex(handle);
    if (index == nullptr) {
        return 0;
    }
    return index->importState(data, size) ? 1 : 0;
}

}
