export interface TrayRuntimeStatus {
  installed: boolean;
  processRunning: boolean;
  healthy: boolean;
  ready: boolean;
}

export interface TrayMenuState {
  tooltip: string;
  statusLabel: string;
  actionLabel: string;
  actionEnabled: boolean;
}

export interface MutableTrayMenuItem {
  label: string;
  enabled: boolean;
}

export interface TrayMenuLike {
  getMenuItemById(id: string): MutableTrayMenuItem | null | undefined;
}

export const TRAY_STATUS_MENU_ID = "tray-tunnel-status";
export const TRAY_ACTION_MENU_ID = "tray-tunnel-action";

export function trayMenuStateEqual(left: TrayMenuState, right: TrayMenuState): boolean {
  return left.tooltip === right.tooltip
    && left.statusLabel === right.statusLabel
    && left.actionLabel === right.actionLabel
    && left.actionEnabled === right.actionEnabled;
}

function tunnelMenuLabel(status?: TrayRuntimeStatus): string {
  if (!status) return "Tunnel: Checking…";
  if (!status.installed) return "Tunnel: Not installed";
  if (status.ready) return "Tunnel: Ready";
  if (status.healthy) return "Tunnel: Healthy";
  if (status.processRunning) return "Tunnel: Running";
  return "Tunnel: Stopped";
}

export function getTrayMenuState(status: TrayRuntimeStatus | undefined, validationState: string): TrayMenuState {
  return {
    tooltip: status?.ready ? "Codex BEG — Tunnel ready" : "Codex BEG",
    statusLabel: tunnelMenuLabel(status),
    actionLabel: status?.processRunning ? "Stop Tunnel" : "Start Tunnel",
    actionEnabled: Boolean(status?.installed && validationState === "valid"),
  };
}

export function updateTrayMenuItems(menu: TrayMenuLike, state: TrayMenuState): void {
  const statusItem = menu.getMenuItemById(TRAY_STATUS_MENU_ID);
  if (statusItem) statusItem.label = state.statusLabel;
  const actionItem = menu.getMenuItemById(TRAY_ACTION_MENU_ID);
  if (actionItem) {
    actionItem.label = state.actionLabel;
    actionItem.enabled = state.actionEnabled;
  }
}
