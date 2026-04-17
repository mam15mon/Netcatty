import { useCallback, useEffect, useState } from "react";
import { localStorageAdapter } from "../../infrastructure/persistence/localStorageAdapter";

/**
 * Hook for persisting a string value to localStorage with cross-window sync.
 * Syncs across components in the same window via a custom event,
 * and across windows via the native storage event.
 */
export const useStoredSyncedString = <T extends string = string>(
    storageKey: string,
    fallback: T,
    validate?: (value: string) => value is T,
) => {
    const resolveStored = useCallback((): T => {
        const stored = localStorageAdapter.readString(storageKey);
        if (stored === null) return fallback;
        if (validate) return validate(stored) ? stored : fallback;
        return stored as T;
    }, [storageKey, fallback, validate]);

    const [value, setValue] = useState<T>(resolveStored);

    const setAndPersist = useCallback((next: T | ((prev: T) => T)) => {
        setValue((prev) => {
            const resolved = typeof next === "function" ? (next as (prev: T) => T)(prev) : next;
            localStorageAdapter.writeString(storageKey, resolved);
            window.dispatchEvent(
                new CustomEvent("stored-string-change", { detail: { key: storageKey, value: resolved } }),
            );
            return resolved;
        });
    }, [storageKey]);

    useEffect(() => {
        const handleCustom = (event: Event) => {
            const detail = (event as CustomEvent).detail as { key?: string; value?: string } | undefined;
            if (detail?.key !== storageKey || typeof detail.value !== "string") return;
            const next = validate && !validate(detail.value)
                ? fallback
                : (detail.value as T);
            setValue(next);
        };

        const handleStorage = (event: StorageEvent) => {
            if (event.key !== storageKey) return;
            setValue(resolveStored());
        };

        window.addEventListener("stored-string-change", handleCustom);
        window.addEventListener("storage", handleStorage);
        return () => {
            window.removeEventListener("stored-string-change", handleCustom);
            window.removeEventListener("storage", handleStorage);
        };
    }, [storageKey, fallback, validate, resolveStored]);

    return [value, setAndPersist] as const;
};
