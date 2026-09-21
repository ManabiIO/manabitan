static int set_field(const uint8_t* src, TermRowMeta* meta, uint32_t field_index, uint32_t start, uint32_t end) {
    uint32_t length = end > start ? (end - start) : 0u;
    switch (field_index) {
        case 0: meta->expression_start = start; meta->expression_length = length; break;
        case 1: meta->reading_start = start; meta->reading_length = length; break;
        case 2: meta->definition_tags_start = start; meta->definition_tags_length = length; break;
        case 3: meta->rules_start = start; meta->rules_length = length; break;
        case 4:
            if (!is_valid_json_number(src, start, end)) { return 0; }
            meta->score_start = start; break;
        case 5: meta->glossary_start = start; meta->glossary_length = length; break;
        case 6: return parse_int32_token(src, start, end, -1, &meta->sequence);
        case 7: meta->term_tags_start = start; meta->term_tags_length = length; break;
        default: break;
    }
    return 1;
}
