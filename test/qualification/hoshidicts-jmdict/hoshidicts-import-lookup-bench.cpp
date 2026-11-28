/* SPDX-License-Identifier: GPL-3.0-or-later */

#include <openssl/sha.h>

#include <chrono>
#include <cstdint>
#include <filesystem>
#include <iomanip>
#include <iostream>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#include "hoshidicts/deconjugator.hpp"
#include "hoshidicts/importer.hpp"
#include "hoshidicts/lookup.hpp"
#include "hoshidicts/query.hpp"

namespace {
using Clock = std::chrono::steady_clock;
void append_field(std::string& bytes, std::string_view field) {
  const auto length = static_cast<std::uint64_t>(field.size());
  for (int shift = 56; shift >= 0; shift -= 8) bytes.push_back(static_cast<char>((length >> shift) & 0xff));
  bytes.append(field.data(), field.size());
}
std::string sha256(std::string_view bytes) {
  unsigned char digest[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(bytes.data()), bytes.size(), digest);
  std::ostringstream out;
  out << std::hex << std::setfill('0');
  for (unsigned char byte : digest) out << std::setw(2) << static_cast<unsigned int>(byte);
  return out.str();
}
std::string json_escape(std::string_view value) {
  std::string out;
  for (unsigned char byte : value) {
    switch (byte) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (byte < 0x20) {
          out += "\\u00";
          constexpr char digits[] = "0123456789abcdef";
          out += digits[(byte >> 4) & 0xf]; out += digits[byte & 0xf];
        } else out += static_cast<char>(byte);
    }
  }
  return out;
}
double elapsed_ms(Clock::time_point start, Clock::time_point end) {
  return std::chrono::duration<double, std::milli>(end - start).count();
}
}  // namespace

int main(int argc, char** argv) {
  if (argc == 2 && std::string_view(argv[1]) == "--verify-sha256") {
    std::cout << sha256("abc") << "\n";
    return 0;
  }
  if (argc != 7) {
    std::cerr << "usage: hoshi-import-lookup-bench <zip> <output-dir> <query> <expected-title> <expected-terms> <run-id>\n";
    return 2;
  }
  try {
    const std::filesystem::path archive = std::filesystem::canonical(argv[1]);
    const std::filesystem::path output = std::filesystem::canonical(argv[2]);
    const std::string query_text = argv[3], expected_title = argv[4], run_id = argv[6];
    const auto expected_terms = static_cast<std::size_t>(std::stoull(argv[5]));
    if (query_text.empty() || expected_title.empty() || run_id.empty() || !std::filesystem::is_directory(output))
      throw std::runtime_error("invalid archive, output directory, query, title, or run identifier");
    if (std::filesystem::exists(output / expected_title)) throw std::runtime_error("output already contains target dictionary");
    const auto total_start = Clock::now();
    const auto imported = dictionary_importer::import(archive.string(), output.string());
    const auto import_end = Clock::now();
    if (!imported.success) {
      std::ostringstream errors;
      for (const auto& error : imported.errors) errors << error << "\n";
      throw std::runtime_error("Hoshidicts import failed: " + errors.str());
    }
    DictionaryQuery query;
    query.add_term_dict((output / imported.title).string());
    Deconjugator deconjugator;
    Lookup lookup(query, deconjugator);
    const auto results = lookup.lookup(query_text);
    const auto lookup_end = Clock::now();
    bool exact_headword = false, matching_dictionary = false, nonempty_glossary = false;
    std::set<std::pair<std::string, std::string>> unique_pairs;
    std::string digest_input;
    append_field(digest_input, query_text); append_field(digest_input, imported.title);
    for (const auto& result : results) {
      append_field(digest_input, result.matched); append_field(digest_input, result.term.expression); append_field(digest_input, result.term.reading);
      unique_pairs.emplace(result.term.expression, result.term.reading);
      exact_headword = exact_headword || result.term.expression == query_text;
      for (const auto& glossary : result.term.glossaries) {
        append_field(digest_input, glossary.dict_name); append_field(digest_input, glossary.glossary);
        append_field(digest_input, glossary.definition_tags); append_field(digest_input, glossary.term_tags);
        if (glossary.dict_name == expected_title) { matching_dictionary = true; nonempty_glossary = nonempty_glossary || !glossary.glossary.empty(); }
      }
    }
    if (imported.title != expected_title || imported.term_count != expected_terms || results.empty() || !exact_headword || !matching_dictionary || !nonempty_glossary)
      throw std::runtime_error("Hoshidicts semantic validation failed");
    std::cout << std::fixed << std::setprecision(3)
      << "{\"engine\":\"hoshidicts\",\"runId\":\"" << json_escape(run_id) << "\",\"archive\":\"" << json_escape(archive.string())
      << "\",\"query\":\"" << json_escape(query_text) << "\",\"title\":\"" << json_escape(imported.title)
      << "\",\"termCount\":" << imported.term_count << ",\"mediaCount\":" << imported.media_count
      << ",\"resultCount\":" << results.size() << ",\"configuredMaxResults\":16,\"configuredScanLength\":16,\"headwordPairCount\":" << unique_pairs.size() << ",\"headwordPairs\":[";
    bool first = true;
    for (const auto& pair : unique_pairs) { if (!first) std::cout << ','; first = false; std::cout << "{\"expression\":\"" << json_escape(pair.first) << "\",\"reading\":\"" << json_escape(pair.second) << "\"}"; }
    std::cout << "],\"orderedResults\":[";
    for (std::size_t i = 0; i < results.size(); ++i) {
      if (i) std::cout << ',';
      const auto& result = results[i]; bool hydrated = false;
      for (const auto& glossary : result.term.glossaries) if (glossary.dict_name == expected_title && !glossary.glossary.empty()) hydrated = true;
      std::cout << "{\"expression\":\"" << json_escape(result.term.expression) << "\",\"reading\":\"" << json_escape(result.term.reading)
                << "\",\"matched\":\"" << json_escape(result.matched) << "\",\"hydrated\":" << (hydrated ? "true" : "false") << '}';
    }
    std::cout << "],\"exactHeadword\":" << (exact_headword ? "true" : "false") << ",\"dictionaryMatched\":" << (matching_dictionary ? "true" : "false")
      << ",\"nonemptyGlossary\":" << (nonempty_glossary ? "true" : "false") << ",\"importMs\":" << elapsed_ms(total_start, import_end)
      << ",\"lookupStageMs\":" << elapsed_ms(import_end, lookup_end) << ",\"totalMs\":" << elapsed_ms(total_start, lookup_end)
      << ",\"resultSha256\":\"" << sha256(digest_input) << "\"}\n";
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
  return 0;
}
