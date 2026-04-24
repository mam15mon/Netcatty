import { useEffect, useState } from "react";
import { localStorageAdapter } from "../../infrastructure/persistence/localStorageAdapter";

type StoredStringOptions = {
    debounceMs?: number;
    maxPersistedLength?: number;
};

/**
 * Hook for persisting a string value to localStorage.
 * @param storageKey - The key to use for localStorage
 * @param fallback - The default value if no stored value exists
 * @param validate - Optional function to validate stored value; returns fallback if invalid
 * @param options - Optional persistence tuning (debounce and max persisted length)
 * @returns A tuple of [value, setValue] similar to useState
 */
export const useStoredString = <T extends string = string>(
    storageKey: string,
    fallback: T,
    validate?: (value: string) => value is T,
    options?: StoredStringOptions,
) => {
    const [value, setValue] = useState<T>(() => {
        const stored = localStorageAdapter.readString(storageKey);
        if (stored === null) return fallback;
        if (validate) return validate(stored) ? stored : fallback;
        return stored as T;
    });

    useEffect(() => {
        const debounceMs = options?.debounceMs ?? 0;
        const maxPersistedLength = options?.maxPersistedLength;
        const persistedValue =
            typeof maxPersistedLength === "number" && maxPersistedLength >= 0 && value.length > maxPersistedLength
                ? value.slice(0, maxPersistedLength)
                : value;

        if (debounceMs <= 0) {
            localStorageAdapter.writeString(storageKey, persistedValue);
            return;
        }

        const timer = setTimeout(() => {
            localStorageAdapter.writeString(storageKey, persistedValue);
        }, debounceMs);
        return () => clearTimeout(timer);
    }, [storageKey, value, options?.debounceMs, options?.maxPersistedLength]);

    return [value, setValue] as const;
};
