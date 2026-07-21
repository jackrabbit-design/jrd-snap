use image::{ImageBuffer, Rgba};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

pub fn crop_to_rect(
    full: &ImageBuffer<Rgba<u8>, Vec<u8>>,
    rect: CaptureRect,
) -> ImageBuffer<Rgba<u8>, Vec<u8>> {
    let x = rect.x.max(0) as u32;
    let y = rect.y.max(0) as u32;
    let width = rect.width.min(full.width().saturating_sub(x));
    let height = rect.height.min(full.height().saturating_sub(y));
    image::imageops::crop_imm(full, x, y, width, height).to_image()
}

pub fn encode_png(img: &ImageBuffer<Rgba<u8>, Vec<u8>>) -> Result<Vec<u8>, String> {
    let mut bytes: Vec<u8> = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(bytes)
}

fn primary_monitor() -> Result<xcap::Monitor, String> {
    let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
    let fallback_index = monitors
        .iter()
        .position(|m| m.is_primary().unwrap_or(false))
        .unwrap_or(0);
    monitors
        .into_iter()
        .nth(fallback_index)
        .ok_or_else(|| "no monitor found".to_string())
}

pub fn capture_full_screen_png() -> Result<Vec<u8>, String> {
    let monitor = primary_monitor()?;
    let img = monitor.capture_image().map_err(|e| e.to_string())?;
    encode_png(&img)
}

pub fn capture_area_png(rect: CaptureRect) -> Result<Vec<u8>, String> {
    let monitor = primary_monitor()?;
    let img = monitor.capture_image().map_err(|e| e.to_string())?;
    let cropped = crop_to_rect(&img, rect);
    encode_png(&cropped)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid_image(width: u32, height: u32) -> ImageBuffer<Rgba<u8>, Vec<u8>> {
        ImageBuffer::from_fn(width, height, |x, y| {
            Rgba([(x % 256) as u8, (y % 256) as u8, 0, 255])
        })
    }

    #[test]
    fn crop_produces_requested_dimensions() {
        let full = solid_image(200, 100);
        let cropped = crop_to_rect(&full, CaptureRect { x: 10, y: 10, width: 50, height: 30 });
        assert_eq!(cropped.width(), 50);
        assert_eq!(cropped.height(), 30);
    }

    #[test]
    fn crop_clamps_to_image_bounds() {
        let full = solid_image(100, 100);
        let cropped = crop_to_rect(&full, CaptureRect { x: 90, y: 90, width: 50, height: 50 });
        assert_eq!(cropped.width(), 10);
        assert_eq!(cropped.height(), 10);
    }

    #[test]
    fn crop_preserves_pixel_content() {
        let full = solid_image(100, 100);
        let cropped = crop_to_rect(&full, CaptureRect { x: 5, y: 5, width: 10, height: 10 });
        assert_eq!(cropped.get_pixel(0, 0), full.get_pixel(5, 5));
    }

    #[test]
    fn encode_png_round_trips_through_decode() {
        let img = solid_image(10, 10);
        let bytes = encode_png(&img).unwrap();
        let decoded = image::load_from_memory(&bytes).unwrap().to_rgba8();
        assert_eq!(decoded.width(), 10);
        assert_eq!(decoded.height(), 10);
    }
}
