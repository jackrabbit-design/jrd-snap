pub fn build_object_key(key_prefix: Option<&str>, filename: &str) -> String {
    match key_prefix {
        Some(p) if !p.is_empty() => {
            let trimmed = p.trim_end_matches('/');
            format!("{trimmed}/{filename}")
        }
        _ => filename.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_prefix_returns_filename_unchanged() {
        assert_eq!(build_object_key(None, "abc123.png"), "abc123.png");
    }

    #[test]
    fn prefix_without_trailing_slash_gets_one_added() {
        assert_eq!(
            build_object_key(Some("team-chris"), "abc123.png"),
            "team-chris/abc123.png"
        );
    }

    #[test]
    fn prefix_with_trailing_slash_is_not_doubled() {
        assert_eq!(
            build_object_key(Some("team-chris/"), "abc123.png"),
            "team-chris/abc123.png"
        );
    }

    #[test]
    fn empty_string_prefix_is_treated_as_no_prefix() {
        assert_eq!(build_object_key(Some(""), "abc123.png"), "abc123.png");
    }
}
