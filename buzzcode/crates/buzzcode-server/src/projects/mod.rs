use std::sync::Arc;

use axum::Router;

use crate::AppState;

mod domain;
mod http;
mod service;
mod store;

pub(crate) fn routes() -> Router<Arc<AppState>> {
    http::routes()
}
