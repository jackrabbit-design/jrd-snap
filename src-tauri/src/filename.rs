// Ordered to match ASCII byte order (0-9 < A-Z < a-z), so that for ids of
// equal length (true for a very long time at millisecond resolution — the
// length only grows once every ~62x longer, i.e. decades), lexicographic
// string comparison of generated filenames matches chronological order.
const BASE62_ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

fn base62_encode(mut n: u128) -> String {
    if n == 0 {
        return "0".to_string();
    }
    let mut chars = Vec::new();
    while n > 0 {
        chars.push(BASE62_ALPHABET[(n % 62) as usize]);
        n /= 62;
    }
    chars.reverse();
    String::from_utf8(chars).unwrap()
}

// Filenames are the base62 encoding of the current unix timestamp (in
// milliseconds) rather than a random id, so the name itself reflects when
// the capture was made instead of being opaque.
pub fn generate_filename(prefix: Option<&str>, extension: &str) -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let id = base62_encode(millis);
    match prefix {
        Some(p) if !p.is_empty() => format!("{p}-{id}.{extension}"),
        _ => format!("{id}.{extension}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base62_decode(s: &str) -> u128 {
        s.bytes().fold(0u128, |acc, b| {
            acc * 62 + BASE62_ALPHABET.iter().position(|&c| c == b).unwrap() as u128
        })
    }

    #[test]
    fn base62_encode_of_zero_is_zero() {
        assert_eq!(base62_encode(0), "0");
    }

    #[test]
    fn base62_encode_round_trips_through_decode() {
        for n in [1u128, 61, 62, 3843, 1_700_000_000_000] {
            assert_eq!(base62_decode(&base62_encode(n)), n);
        }
    }

    #[test]
    fn no_prefix_has_extension_and_alphanumeric_stem() {
        let name = generate_filename(None, "png");
        assert!(name.ends_with(".png"));
        let stem = name.trim_end_matches(".png");
        assert!(!stem.is_empty());
        assert!(stem.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn with_prefix_glues_prefix_dash_id() {
        let name = generate_filename(Some("chris"), "mp4");
        assert!(name.starts_with("chris-"));
        assert!(name.ends_with(".mp4"));
        let stem = name.trim_start_matches("chris-").trim_end_matches(".mp4");
        assert!(!stem.is_empty());
        assert!(stem.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn empty_string_prefix_is_treated_as_no_prefix() {
        let name = generate_filename(Some(""), "png");
        assert!(!name.starts_with('-'));
    }

    #[test]
    fn ids_are_url_safe() {
        let name = generate_filename(None, "png");
        let stem = name.trim_end_matches(".png");
        assert!(stem
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'));
    }

    #[test]
    fn consecutive_ids_sort_chronologically() {
        let a = generate_filename(None, "png");
        let b = generate_filename(None, "png");
        assert!(b >= a);
    }

    #[test]
    fn stem_decodes_back_to_a_plausible_unix_millis_timestamp() {
        let name = generate_filename(None, "png");
        let stem = name.trim_end_matches(".png");
        let decoded = base62_decode(stem);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis();
        assert!(decoded <= now && now - decoded < 1000);
    }
}
