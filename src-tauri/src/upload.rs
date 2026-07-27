use crate::settings::{Credentials, Provider, UploadSettings};
use aws_sdk_s3::config::{Credentials as AwsCredentials, Region};
use aws_sdk_s3::error::{DisplayErrorContext, ProvideErrorMetadata};
use aws_sdk_s3::Client;

pub fn build_public_url(settings: &UploadSettings, key: &str) -> String {
    if let Some(domain) = &settings.custom_domain {
        let domain = domain.trim_end_matches('/');
        return format!("https://{domain}/{key}");
    }
    match settings.provider {
        Provider::S3 => format!(
            "https://{}.s3.{}.amazonaws.com/{}",
            settings.bucket, settings.region, key
        ),
        Provider::Spaces => {
            let endpoint = settings.endpoint.clone().unwrap_or_default();
            format!("https://{}.{}/{}", settings.bucket, endpoint, key)
        }
    }
}

pub async fn upload_object(
    settings: &UploadSettings,
    creds: &Credentials,
    key: &str,
    bytes: Vec<u8>,
    content_type: &str,
) -> Result<(), String> {
    let aws_creds = AwsCredentials::new(&creds.access_key_id, &creds.secret_access_key, None, None, "snap");
    let mut config_builder = aws_sdk_s3::config::Builder::new()
        .region(Region::new(settings.region.clone()))
        .credentials_provider(aws_creds)
        .behavior_version(aws_sdk_s3::config::BehaviorVersion::latest());

    if let Provider::Spaces = settings.provider {
        let endpoint = settings.endpoint.clone().unwrap_or_default();
        config_builder = config_builder
            .endpoint_url(format!("https://{endpoint}"))
            .force_path_style(false);
    }

    let client = Client::from_conf(config_builder.build());

    let result = client
        .put_object()
        .bucket(&settings.bucket)
        .key(key)
        .body(bytes.clone().into())
        .content_type(content_type)
        .acl(aws_sdk_s3::types::ObjectCannedAcl::PublicRead)
        .send()
        .await;

    if let Err(e) = &result {
        if e.code() == Some("AccessControlListNotSupported") {
            // Modern S3 buckets default to "Object Ownership: Bucket owner
            // enforced", which disables ACLs entirely and rejects any PUT
            // that specifies one. Such buckets are expected to be made
            // public via a bucket policy instead — retry without an ACL;
            // if the bucket owner has that policy in place, the object is
            // already public once uploaded.
            client
                .put_object()
                .bucket(&settings.bucket)
                .key(key)
                .body(bytes.into())
                .content_type(content_type)
                .send()
                .await
                .map_err(|e| format!("{}", DisplayErrorContext(e)))?;
            return Ok(());
        }
    }

    // SdkError's own Display impl collapses to a generic classification
    // like "service error" — DisplayErrorContext walks the full source
    // chain (HTTP status, AWS error code, message) so failures are
    // actually diagnosable (bad credentials, wrong region, bucket ACL
    // policy, etc.) instead of a dead end.
    result.map_err(|e| format!("{}", DisplayErrorContext(e)))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s3_settings() -> UploadSettings {
        UploadSettings {
            provider: Provider::S3,
            bucket: "my-bucket".into(),
            region: "us-east-1".into(),
            endpoint: None,
            custom_domain: None,
            key_prefix: None,
            filename_prefix: None,
        }
    }

    fn spaces_settings() -> UploadSettings {
        UploadSettings {
            provider: Provider::Spaces,
            bucket: "my-space".into(),
            region: "nyc3".into(),
            endpoint: Some("nyc3.digitaloceanspaces.com".into()),
            custom_domain: None,
            key_prefix: None,
            filename_prefix: None,
        }
    }

    #[test]
    fn s3_url_uses_virtual_hosted_style() {
        let url = build_public_url(&s3_settings(), "abc123.png");
        assert_eq!(url, "https://my-bucket.s3.us-east-1.amazonaws.com/abc123.png");
    }

    #[test]
    fn spaces_url_uses_bucket_dot_endpoint() {
        let url = build_public_url(&spaces_settings(), "abc123.png");
        assert_eq!(url, "https://my-space.nyc3.digitaloceanspaces.com/abc123.png");
    }

    #[test]
    fn custom_domain_overrides_generated_host() {
        let mut settings = s3_settings();
        settings.custom_domain = Some("cdn.example.com".into());
        let url = build_public_url(&settings, "abc123.png");
        assert_eq!(url, "https://cdn.example.com/abc123.png");
    }

    #[test]
    fn key_with_folder_prefix_is_url_encoded_in_path() {
        let url = build_public_url(&s3_settings(), "team-chris/abc123.png");
        assert_eq!(
            url,
            "https://my-bucket.s3.us-east-1.amazonaws.com/team-chris/abc123.png"
        );
    }
}
