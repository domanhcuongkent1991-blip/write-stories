import { afterEach, describe, expect, it, vi } from "vitest";

interface FakeStorageOptions {
  readonly initial?: Readonly<Record<string, string>>;
  readonly throwOnGet?: boolean;
  readonly throwOnSet?: boolean;
}

function createFakeStorage(options: FakeStorageOptions = {}): Storage {
  const values = new Map(Object.entries(options.initial ?? {}));

  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      if (options.throwOnGet) throw new Error("storage read failed");
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      if (options.throwOnSet) throw new Error("storage write failed");
      values.set(key, value);
    },
  };
}

async function loadUiLocale() {
  vi.resetModules();
  return import("./ui-locale");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("UI locale preference", () => {
  it("validates only supported locale values", async () => {
    const { isUiLocale } = await loadUiLocale();

    expect(isUiLocale("vi")).toBe(true);
    expect(isUiLocale("vi-VN")).toBe(false);
    expect(isUiLocale("en")).toBe(true);
    expect(isUiLocale("zh")).toBe(true);
  });

  it("resolves an explicit preference before the writing language", async () => {
    const { resolveUiLocale } = await loadUiLocale();

    expect(resolveUiLocale(null, "en")).toBe("en");
    expect(resolveUiLocale(null, "zh")).toBe("zh");
    expect(resolveUiLocale("vi", "en")).toBe("vi");
    expect(resolveUiLocale(null, undefined)).toBe("zh");
  });

  it("reads a valid stored preference and ignores an invalid value", async () => {
    const storageKey = "inkos:studio:ui-locale";
    vi.stubGlobal("localStorage", createFakeStorage({ initial: { [storageKey]: "vi" } }));
    const validModule = await loadUiLocale();
    expect(validModule.getUiLocalePreference()).toBe("vi");

    vi.stubGlobal("localStorage", createFakeStorage({ initial: { [storageKey]: "vi-VN" } }));
    const invalidModule = await loadUiLocale();
    expect(invalidModule.getUiLocalePreference()).toBeNull();
  });

  it("does not access storage during module initialization", async () => {
    const getItem = vi.fn(() => null);
    const storage = createFakeStorage();
    vi.stubGlobal("localStorage", { ...storage, getItem });

    const localeModule = await loadUiLocale();
    expect(getItem).not.toHaveBeenCalled();

    expect(localeModule.getUiLocalePreference()).toBeNull();
    expect(getItem).toHaveBeenCalledOnce();
  });

  it("survives storage failures and keeps the selected locale for the session", async () => {
    vi.stubGlobal("localStorage", createFakeStorage({ throwOnGet: true, throwOnSet: true }));
    const localeModule = await loadUiLocale();

    expect(localeModule.getUiLocalePreference()).toBeNull();
    expect(() => localeModule.setUiLocalePreference("vi")).not.toThrow();
    expect(localeModule.getUiLocalePreference()).toBe("vi");
  });

  it("isolates throwing subscribers and honors unsubscribe", async () => {
    vi.stubGlobal("localStorage", createFakeStorage());
    const localeModule = await loadUiLocale();
    const survivor = vi.fn();

    localeModule.subscribeUiLocale(() => {
      throw new Error("subscriber failed");
    });
    const unsubscribe = localeModule.subscribeUiLocale(survivor);

    localeModule.setUiLocalePreference("vi");
    expect(survivor).toHaveBeenCalledOnce();

    unsubscribe();
    localeModule.setUiLocalePreference("en");
    expect(survivor).toHaveBeenCalledOnce();
  });
});
