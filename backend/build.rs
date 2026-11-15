//! Keeps the backend's demo history identical to the frontend's: one demo story.
//! When the frontend folder is present, its history.raw.json is copied to data/demo/ before the
//! crate is compiled (src/seed.rs embeds that copy). Without the frontend folder the committed
//! copy is used as it is.
use std::{fs, path::Path};

fn main() {
    let source = Path::new("../frontend/src/data/demo/history.raw.json");
    let copy = Path::new("data/demo/history.raw.json");
    println!("cargo:rerun-if-changed={}", source.display());
    println!("cargo:rerun-if-changed={}", copy.display());
    let Ok(wanted) = fs::read(source) else { return };
    if fs::read(copy).ok().as_deref() != Some(wanted.as_slice()) {
        fs::create_dir_all("data/demo").expect("cannot create data/demo");
        fs::write(copy, wanted).expect("cannot write data/demo/history.raw.json");
    }
}
