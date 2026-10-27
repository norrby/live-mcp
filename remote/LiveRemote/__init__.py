# LiveRemote – Ableton Live Remote Script (Control Surface) that exposes a
# limited subset of the Live Object Model over a local TCP port, so that local
# tools can modify the open set: tracks, routing, devices,
# parameters. No arbitrary code execution: only the existing cmd_* methods.
from .LiveRemote import LiveRemote


def create_instance(c_instance):
    return LiveRemote(c_instance)
