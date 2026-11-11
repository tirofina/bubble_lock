"""Inventory a stopped Gateway database before changing its deployment settings."""
from contextlib import closing

from .config import GatewayConfig
from .model import canonical, iso_time
from .state_identity import BASE_TABLES, StateIdentityError, configured_binding, match, metadata, readonly, tables
from .store import CORE_TELEMETRY_EPOCH_MATCH, CORE_TELEMETRY_ROWS


def cutover_plan(current: GatewayConfig, target: GatewayConfig) -> dict:
    """Caller holds the source daemon lock. Return aggregate local state only."""
    current_binding = configured_binding(current)
    target_binding = configured_binding(target)
    changed_binding = sorted(
        key for key in current_binding.keys() | target_binding.keys()
        if current_binding.get(key) != target_binding.get(key)
    )
    source_path, target_path = current.database.resolve(), target.database.resolve()
    if not changed_binding:
        if (source_path != target_path or
                current.database.with_suffix(".lock").resolve() != target.database.with_suffix(".lock").resolve()):
            raise StateIdentityError("STATE_CUTOVER_REQUIRES_SOURCE_DATABASE")
        action = "reuse-existing"
    else:
        if source_path == target_path:
            raise StateIdentityError("STATE_CUTOVER_REQUIRES_NEW_DATABASE")
        for suffix in ("", "-wal", "-shm", "-journal"):
            path = target.database.with_name(target.database.name + suffix)
            if path.exists() or path.is_symlink():
                raise StateIdentityError("STATE_CUTOVER_TARGET_PATH_IN_USE")
        action = "use-new-database"

    changed_endpoints = []
    if current.cse_url != target.cse_url:
        changed_endpoints.append("cseUrl")
    if current.api_url != target.api_url:
        changed_endpoints.append("pcApiUrl")
    if (current.mqtt_host, current.mqtt_port) != (target.mqtt_host, target.mqtt_port):
        changed_endpoints.append("mqttBroker")
    delivery_settings = (
        "commands_enabled", "core_bridge_enabled", "core_telemetry_epochs", "m2m_mqtt_enabled",
        "mqtt_wrapped_primitive", "central_receipts_enabled", "central_telemetry_enabled",
        "central_telemetry_retention_seconds", "pc_dispatch_start_required",
    )
    changed_delivery = [name for name in delivery_settings if getattr(current, name) != getattr(target, name)]
    source_central_staging = current.commands_enabled and current.central_receipts_enabled

    with closing(readonly(current.database)) as db:
        db.execute("BEGIN")
        names = tables(db)
        record = metadata(db, names)
        if record is None:
            raise StateIdentityError("STATE_LEGACY_ADOPTION_REQUIRED")
        match(record, current_binding)
        if not set(BASE_TABLES) <= names:
            raise StateIdentityError("STATE_INCOMPLETE_SCHEMA")

        credential_table = "credential_receipts" in names
        credential_route = ("WHEN EXISTS (SELECT 1 FROM credential_receipts c WHERE c.rqi=o.rqi) "
                            "THEN 'credentialReceipt'" if credential_table else "")
        outbox = dict(db.execute(f"""
            SELECT CASE
                WHEN o.container='@core/telemetry' THEN 'coreTelemetry'
                WHEN o.container='@core/ack' THEN 'coreAck'
                WHEN o.container='@central/telemetry' THEN 'centralTelemetry'
                WHEN o.container='@central/receipt' THEN 'centralReceipt'
                WHEN o.command_id IS NOT NULL AND o.container=? THEN 'nativeCommandReceipt'
                {credential_route}
                WHEN o.command_id IS NULL AND o.container IN (?, ?) THEN 'nativeObservationOrHealth'
                ELSE 'unrecognized'
            END AS route, COUNT(*) FROM outbox o GROUP BY route
        """, (current.receipt_container, current.observation_container, current.health_container)))

        has_stage_marker = any(row["name"] == "central_receipt_staged"
                               for row in db.execute("PRAGMA table_info(commands)"))
        stage_condition = "AND central_receipt_staged=0" if has_stage_marker else ""
        journal = dict(db.execute(f"""
            SELECT
                COUNT(*) FILTER (WHERE status='RECEIVED') AS commandsReceived,
                COUNT(*) FILTER (WHERE status='DISPATCHING') AS commandsDispatching,
                COUNT(*) FILTER (WHERE receipt IS NOT NULL AND receipt_delivered=0
                    AND NOT EXISTS (SELECT 1 FROM outbox WHERE outbox.command_id=commands.command_id))
                    AS nativeReceiptsNotStaged,
                COUNT(*) FILTER (WHERE receipt IS NOT NULL {stage_condition})
                    AS centralReceiptsWithoutStageMarker
            FROM commands
        """).fetchone())
        journal["credentialReceiptsNotDelivered"] = (db.execute(
            "SELECT COUNT(*) FROM credential_receipts WHERE delivered_at IS NULL"
        ).fetchone()[0] if credential_table else 0)
        target_holds = None
        if action == "reuse-existing":
            core_scope_held = 0
            if target.core_bridge_enabled and outbox.get("coreTelemetry"):
                epochs = target.core_telemetry_epochs
                core_scope_held = db.execute(f"""
                    WITH core_rows AS ({CORE_TELEMETRY_ROWS})
                    SELECT COUNT(*) FROM core_rows WHERE NOT COALESCE(({CORE_TELEMETRY_EPOCH_MATCH}), 0)
                """, (None if epochs is None else canonical(epochs),)).fetchone()[0]
            central_receipts = outbox.get("centralReceipt", 0)
            if source_central_staging:
                central_receipts += journal["centralReceiptsWithoutStageMarker"]
            native_receipts = outbox.get("nativeCommandReceipt", 0) + journal["nativeReceiptsNotStaged"]
            pending_commands = journal["commandsReceived"] + journal["commandsDispatching"]
            target_holds = {
                "coreTelemetryScopeMismatch": core_scope_held,
                "coreTelemetryBridgeDisabled": 0 if target.core_bridge_enabled else outbox.get("coreTelemetry", 0),
                "coreAckDisabled": (0 if target.core_bridge_enabled and target.commands_enabled
                                    else outbox.get("coreAck", 0)),
                "nativeCommandReceiptsDisabled": 0 if target.commands_enabled else native_receipts,
                "pendingCommandsDisabled": 0 if target.commands_enabled else pending_commands,
                "centralTelemetryDisabled": 0 if target.central_telemetry_enabled else outbox.get("centralTelemetry", 0),
                "centralReceiptsDisabled": (0 if target.commands_enabled and target.central_receipts_enabled
                                            else central_receipts),
            }

    return {
        "reportVersion": 1,
        "capturedAt": iso_time(),
        "databaseAction": action,
        "changedBindingFields": changed_binding,
        "changedEndpointFields": changed_endpoints,
        "changedDeliverySettings": changed_delivery,
        "targetMissingDeploymentIds": [name for name in ("cseDeploymentId", "pcApiDeploymentId")
                                       if name not in target_binding],
        "sourceCentralReceiptStagingEnabled": source_central_staging,
        "outboxByRoute": outbox,
        "journal": journal,
        "targetHolds": target_holds,
    }
