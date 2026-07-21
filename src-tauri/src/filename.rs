pub fn generate_filename(prefix: Option<&str>, extension: &str) -> String {
    let id = nanoid::nanoid!(6);
    match prefix {
        Some(p) if !p.is_empty() => format!("{p}-{id}.{extension}"),
        _ => format!("{id}.{extension}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_prefix_has_six_char_id_and_extension() {
        let name = generate_filename(None, "png");
        assert!(name.ends_with(".png"));
        let stem = name.trim_end_matches(".png");
        assert_eq!(stem.len(), 6);
    }

    #[test]
    fn with_prefix_glues_prefix_dash_id() {
        let name = generate_filename(Some("chris"), "mp4");
        assert!(name.starts_with("chris-"));
        assert!(name.ends_with(".mp4"));
        let stem = name.trim_start_matches("chris-").trim_end_matches(".mp4");
        assert_eq!(stem.len(), 6);
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
        assert!(stem.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'));
    }
}
