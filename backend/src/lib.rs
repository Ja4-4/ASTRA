//! ASTRA backend (Rust): SQLite + axum. Serves the JSON API under /api and any HTML front end from ./static.
pub mod adapter;
pub mod atlas;
pub mod ai;
pub mod api;
pub mod db;
pub mod exercise;
pub mod eye;
pub mod logic;
pub mod seed;
