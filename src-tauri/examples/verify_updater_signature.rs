use std::{env, fs};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};

fn decode_wrapped(value: &str) -> Result<String, Box<dyn std::error::Error>> {
    Ok(String::from_utf8(STANDARD.decode(value.trim())?)?)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let payload_path = args.next().ok_or("missing payload path")?;
    let signature_path = args.next().ok_or("missing signature path")?;
    let wrapped_public_key = args.next().ok_or("missing updater public key")?;
    if args.next().is_some() {
        return Err("unexpected extra argument".into());
    }

    let public_key = PublicKey::decode(&decode_wrapped(&wrapped_public_key)?)?;
    let wrapped_signature = fs::read_to_string(signature_path)?;
    let signature = Signature::decode(&decode_wrapped(&wrapped_signature)?)?;
    let payload = fs::read(payload_path)?;
    public_key.verify(&payload, &signature, true)?;
    Ok(())
}
