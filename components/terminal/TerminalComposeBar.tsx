/**
 * Terminal Compose Bar
 * A modern text input bar for composing commands before sending them.
 * Supports pre-reviewing passwords/commands and broadcasting to multiple sessions.
 */
import { Radio, Send, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { cn } from '../../lib/utils';

type ComposeSendTarget = 'current-tab' | 'current-split' | 'all-sessions';

export interface TerminalComposeBarProps {
    onSend: (text: string) => void;
    onClose: () => void;
    isBroadcastEnabled?: boolean;
    showBroadcastToggle?: boolean;
    onToggleBroadcast?: () => void;
    themeColors?: {
        background: string;
        foreground: string;
    };
    value?: string;
    onValueChange?: (value: string) => void;
    sendTarget?: ComposeSendTarget;
    onSendTargetChange?: (target: ComposeSendTarget) => void;
}

export const TerminalComposeBar: React.FC<TerminalComposeBarProps> = ({
    onSend,
    onClose,
    isBroadcastEnabled,
    showBroadcastToggle,
    onToggleBroadcast,
    themeColors,
    value,
    onValueChange,
    sendTarget = 'current-split',
    onSendTargetChange,
}) => {
    const { t } = useI18n();
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const isComposingRef = useRef(false);
    const [internalValue, setInternalValue] = useState('');
    const inputValue = value ?? internalValue;

    // Auto-focus on mount
    useEffect(() => {
        // Small delay to ensure the element is rendered
        const timer = setTimeout(() => textareaRef.current?.focus(), 50);
        return () => clearTimeout(timer);
    }, []);

    const setComposeText = useCallback((next: string) => {
        if (onValueChange) {
            onValueChange(next);
            return;
        }
        setInternalValue(next);
    }, [onValueChange]);

    // Auto-resize textarea
    const resizeTextarea = useCallback(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    }, []);

    useEffect(() => {
        resizeTextarea();
    }, [inputValue, resizeTextarea]);

    const handleInput = useCallback((e: React.FormEvent<HTMLTextAreaElement>) => {
        setComposeText(e.currentTarget.value);
    }, [setComposeText]);

    const handleSend = useCallback(() => {
        const text = inputValue;
        if (!text) return;
        onSend(text);
        setComposeText('');
        const el = textareaRef.current;
        if (el) {
            el.style.height = 'auto';
            el.focus();
        }
    }, [inputValue, onSend, setComposeText]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey && !isComposingRef.current) {
            e.preventDefault();
            handleSend();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
        }
    }, [handleSend, onClose]);

    const bg = themeColors?.background ?? '#0a0a0a';
    const fg = themeColors?.foreground ?? '#d4d4d4';
    const resolvedBg = 'var(--terminal-ui-bg, ' + bg + ')';
    const resolvedFg = 'var(--terminal-ui-fg, ' + fg + ')';

    return (
        <div
            className="flex-shrink-0"
            style={{
                background: `linear-gradient(to top, ${resolvedBg}, color-mix(in srgb, ${resolvedFg} 4%, ${resolvedBg} 96%))`,
                borderTop: `1px solid color-mix(in srgb, ${resolvedFg} 10%, ${resolvedBg} 90%)`,
                borderRadius: '0 0 8px 8px',
                padding: '6px 10px',
            }}
        >
            <div className="flex items-center gap-2">
                {showBroadcastToggle ? (
                    <button
                        type="button"
                        className="h-7 w-7 flex items-center justify-center rounded-md transition-colors duration-150"
                        style={{
                            color: isBroadcastEnabled
                                ? '#fbbf24'
                                : `color-mix(in srgb, ${resolvedFg} 60%, ${resolvedBg} 40%)`,
                            background: `color-mix(in srgb, ${resolvedFg} 12%, ${resolvedBg} 88%)`,
                        }}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.background = `color-mix(in srgb, ${resolvedFg} 22%, ${resolvedBg} 78%)`;
                            if (!isBroadcastEnabled) e.currentTarget.style.color = resolvedFg;
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.background = `color-mix(in srgb, ${resolvedFg} 12%, ${resolvedBg} 88%)`;
                            e.currentTarget.style.color = isBroadcastEnabled
                                ? '#fbbf24'
                                : `color-mix(in srgb, ${resolvedFg} 60%, ${resolvedBg} 40%)`;
                        }}
                        onClick={onToggleBroadcast}
                        title={
                            isBroadcastEnabled
                                ? t("terminal.toolbar.broadcastDisable")
                                : t("terminal.toolbar.broadcastEnable")
                        }
                        aria-label={
                            isBroadcastEnabled
                                ? t("terminal.toolbar.broadcastDisable")
                                : t("terminal.toolbar.broadcastEnable")
                        }
                        aria-pressed={isBroadcastEnabled}
                    >
                        <Radio size={13} className={cn(isBroadcastEnabled && "animate-pulse")} />
                    </button>
                ) : isBroadcastEnabled ? (
                    <div
                        className="flex items-center"
                        title={t("terminal.composeBar.broadcasting")}
                    >
                        <Radio size={14} className="text-amber-400 animate-pulse" />
                    </div>
                ) : null}

                {/* Input field */}
                <textarea
                    ref={textareaRef}
                    className={cn(
                        "flex-1 min-w-0 resize-none rounded-md px-3 py-1.5 text-xs font-mono leading-relaxed",
                        "outline-none transition-all duration-200",
                        "placeholder:opacity-40",
                    )}
                    style={{
                        backgroundColor: `color-mix(in srgb, ${resolvedFg} 6%, ${resolvedBg} 94%)`,
                        color: resolvedFg,
                        border: `1px solid color-mix(in srgb, ${resolvedFg} 25%, ${resolvedBg} 75%)`,
                        minHeight: '28px',
                        maxHeight: '120px',
                        boxShadow: `inset 0 1px 3px color-mix(in srgb, ${resolvedBg} 80%, transparent)`,
                    }}
                    rows={1}
                    value={inputValue}
                    placeholder={t("terminal.composeBar.placeholder")}
                    onInput={handleInput}
                    onKeyDown={handleKeyDown}
                    onFocus={(e) => {
                        e.currentTarget.style.borderColor = `color-mix(in srgb, ${resolvedFg} 40%, ${resolvedBg} 60%)`;
                        e.currentTarget.style.boxShadow = `inset 0 1px 3px color-mix(in srgb, ${resolvedBg} 80%, transparent), 0 0 0 1px color-mix(in srgb, ${resolvedFg} 8%, transparent)`;
                    }}
                    onBlur={(e) => {
                        e.currentTarget.style.borderColor = `color-mix(in srgb, ${resolvedFg} 25%, ${resolvedBg} 75%)`;
                        e.currentTarget.style.boxShadow = `inset 0 1px 3px color-mix(in srgb, ${resolvedBg} 80%, transparent)`;
                    }}
                    onCompositionStart={() => { isComposingRef.current = true; }}
                    onCompositionEnd={() => { isComposingRef.current = false; }}
                />
                {onSendTargetChange && (
                    <select
                        className="h-7 rounded-md px-2 text-[11px] font-medium outline-none"
                        style={{
                            backgroundColor: `color-mix(in srgb, ${resolvedFg} 10%, ${resolvedBg} 90%)`,
                            color: resolvedFg,
                            border: `1px solid color-mix(in srgb, ${resolvedFg} 25%, ${resolvedBg} 75%)`,
                        }}
                        value={sendTarget}
                        onChange={(e) => onSendTargetChange(e.target.value as ComposeSendTarget)}
                        title={t("terminal.composeBar.sendTarget")}
                        aria-label={t("terminal.composeBar.sendTarget")}
                    >
                        <option value="current-tab">{t("terminal.composeBar.sendTarget.currentTab")}</option>
                        <option value="current-split">{t("terminal.composeBar.sendTarget.currentSplit")}</option>
                        <option value="all-sessions">{t("terminal.composeBar.sendTarget.allSessions")}</option>
                    </select>
                )}

                {/* Action buttons */}
                <div className="flex items-center gap-0.5">
                    <button
                        className="h-7 w-7 flex items-center justify-center rounded-md transition-colors duration-150"
                        style={{
                            color: resolvedFg,
                            background: `color-mix(in srgb, ${resolvedFg} 20%, ${resolvedBg} 80%)`,
                        }}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.background = `color-mix(in srgb, ${resolvedFg} 30%, ${resolvedBg} 70%)`;
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.background = `color-mix(in srgb, ${resolvedFg} 20%, ${resolvedBg} 80%)`;
                        }}
                        onClick={handleSend}
                        title={t("terminal.composeBar.send")}
                    >
                        <Send size={13} />
                    </button>
                    <button
                        className="h-7 w-7 flex items-center justify-center rounded-md transition-colors duration-150"
                        style={{
                            color: `color-mix(in srgb, ${resolvedFg} 60%, ${resolvedBg} 40%)`,
                            background: `color-mix(in srgb, ${resolvedFg} 12%, ${resolvedBg} 88%)`,
                        }}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.background = `color-mix(in srgb, ${resolvedFg} 22%, ${resolvedBg} 78%)`;
                            e.currentTarget.style.color = resolvedFg;
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.background = `color-mix(in srgb, ${resolvedFg} 12%, ${resolvedBg} 88%)`;
                            e.currentTarget.style.color = `color-mix(in srgb, ${resolvedFg} 60%, ${resolvedBg} 40%)`;
                        }}
                        onClick={onClose}
                        title={t("terminal.composeBar.close")}
                    >
                        <X size={13} />
                    </button>
                </div>
            </div>
        </div>
    );
};

export default TerminalComposeBar;
