import { describe, expect, it } from "vitest";
import {
  getTrayMenuState,
  trayMenuStateEqual,
  TRAY_ACTION_MENU_ID,
  TRAY_STATUS_MENU_ID,
  updateTrayMenuItems,
} from "../../electron/tray-menu.js";

describe("tray menu state", () => {
  it("recognizes timer-only status refreshes as the same menu state", () => {
    const state = getTrayMenuState({ installed: true, processRunning: true, healthy: true, ready: true }, "valid");

    expect(trayMenuStateEqual(state, { ...state })).toBe(true);
    expect(trayMenuStateEqual(state, { ...state, actionLabel: "Start Tunnel" })).toBe(false);
  });

  it("updates the existing menu items without rebuilding the native menu", () => {
    const items = new Map([
      [TRAY_STATUS_MENU_ID, { label: "Tunnel: Checking…", enabled: false }],
      [TRAY_ACTION_MENU_ID, { label: "Start Tunnel", enabled: false }],
    ]);
    const menu = { getMenuItemById: (id: string) => items.get(id) };
    const sameMenu = menu;

    updateTrayMenuItems(menu, getTrayMenuState({ installed: true, processRunning: true, healthy: true, ready: false }, "valid"));

    expect(menu).toBe(sameMenu);
    expect(items.get(TRAY_STATUS_MENU_ID)).toEqual({ label: "Tunnel: Healthy", enabled: false });
    expect(items.get(TRAY_ACTION_MENU_ID)).toEqual({ label: "Stop Tunnel", enabled: true });
  });

  it("keeps the action disabled until tunnel configuration is valid", () => {
    const state = getTrayMenuState({ installed: true, processRunning: false, healthy: false, ready: false }, "unconfigured");
    expect(state.actionLabel).toBe("Start Tunnel");
    expect(state.actionEnabled).toBe(false);
  });
});
