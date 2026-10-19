"""HTTP routers, one module per surface.

Routers reach live process state through the `bind_state` helper their module
exports, so none of them imports `main` (which imports them).
"""
