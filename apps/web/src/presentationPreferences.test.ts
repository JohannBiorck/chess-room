import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyAccountPresentationPreferences,
  createPresentationPreferencesStore,
  DEFAULT_PRESENTATION_PREFERENCES,
  getPresentationPreferences,
  PRESENTATION_PREFERENCES_KEY,
  parsePresentationPreferences,
  updatePresentationPreferences,
} from "./presentationPreferences";

describe("device presentation settings", () => {
  beforeEach(() => updatePresentationPreferences(DEFAULT_PRESENTATION_PREFERENCES));
  it("starts muted, retains a validated saved preference and notifies only real changes", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const store = createPresentationPreferencesStore(storage);
    expect(store.getSnapshot()).toEqual(DEFAULT_PRESENTATION_PREFERENCES);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.update({ volume: 70, motion: "reduced" });
    store.update({ volume: 70 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(createPresentationPreferencesStore(storage).getSnapshot()).toEqual({
      sound: false,
      volume: 70,
      motion: "reduced",
    });
    expect(values.has(PRESENTATION_PREFERENCES_KEY)).toBe(true);
    unsubscribe();
    store.update({ volume: 50 });
    expect(listener).toHaveBeenCalledTimes(1);
  });
  it.each([
    null,
    "bad",
    { sound: "yes", volume: 45, motion: "system" },
    { sound: false, volume: 101, motion: "system" },
    { sound: false, volume: -1, motion: "system" },
    { sound: false, volume: Number.NaN, motion: "system" },
    { sound: false, volume: 25.5, motion: "system" },
    { sound: false, volume: 45, motion: "unknown" },
  ])("rejects invalid stored state: %j", (value) => {
    expect(parsePresentationPreferences(value)).toBeNull();
  });
  it("works when storage is denied or corrupted without preventing gameplay", () => {
    const denied = createPresentationPreferencesStore({
      getItem: () => {
        throw new Error("Denied");
      },
      setItem: () => {
        throw new Error("Denied");
      },
    });
    denied.update({ sound: true, volume: 30 });
    expect(denied.getSnapshot()).toMatchObject({ sound: true, volume: 30 });
    expect(
      createPresentationPreferencesStore({
        getItem: () => "{broken",
        setItem: () => undefined,
      }).getSnapshot(),
    ).toEqual(DEFAULT_PRESENTATION_PREFERENCES);
    denied.update({ volume: 200 });
    expect(denied.getSnapshot().volume).toBe(30);
  });
  it("cannot auto-enable device sound when account settings arrive", () => {
    const account = { sound: true, volume: 80, motion: "reduced" as const };
    applyAccountPresentationPreferences(account);
    expect(getPresentationPreferences()).toEqual({ sound: false, volume: 80, motion: "reduced" });
  });
});
