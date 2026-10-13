"""Data sources. Each has read() -> (telemetry: dict, session_info: dict) | None.

session_info must be a new object whenever its content changes, the engine
re-parses drivers/track only on identity change.
"""
