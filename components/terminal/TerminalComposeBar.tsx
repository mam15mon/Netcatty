/**
 * Terminal Compose Bar
 * A high-fidelity "Command Window" inspired by SecureCRT.
 * Features a header with target selection and a large multi-line input area.
 */
import { Radio, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { cn } from '../../lib/utils';

import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "../ui/select";

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
    availableTargets?: ComposeSendTarget[];
    targetName?: string;
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
    availableTargets,
    targetName: _targetName,
}) => {
    const { t } = useI18n();

    // Fallback translations
    const getLabel = useCallback((key: string, fallback: string) => {
        const val = t(key);
        if (val === key || /^[A-Z._]+$/.test(val)) return fallback;
        return val;
    }, [t]);

    const resolvedTargets = useMemo<ComposeSendTarget[]>(() => {
        const defaults: ComposeSendTarget[] = ['current-split', 'current-tab', 'all-sessions'];
        const source = availableTargets?.length ? availableTargets : defaults;
        const unique: ComposeSendTarget[] = [];
        source.forEach((item) => {
            if (!unique.includes(item)) {
                unique.push(item);
            }
        });
        return unique.length ? unique : defaults;
    }, [availableTargets]);

    const resolvedSendTarget = useMemo<ComposeSendTarget>(() => {
        if (resolvedTargets.includes(sendTarget)) return sendTarget;
        if (resolvedTargets.includes('current-tab')) return 'current-tab';
        return resolvedTargets[0];
    }, [resolvedTargets, sendTarget]);

    const targetLabel = useMemo(() => {
        switch (resolvedSendTarget) {
            case 'current-tab': return getLabel("terminal.composeBar.sendTarget.currentTab", "Active Tab");
            case 'current-split': return getLabel("terminal.composeBar.sendTarget.currentSplit", "Active Session");
            case 'all-sessions': return getLabel("terminal.composeBar.sendTarget.allSessions", "All Sessions");
            default: return resolvedSendTarget;
        }
    }, [resolvedSendTarget, getLabel]);



    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const isComposingRef = useRef(false);
    const [internalValue, setInternalValue] = useState('');
    const inputValue = value ?? internalValue;

    // Auto-focus on mount
    useEffect(() => {
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

    const handleSend = useCallback(() => {
        const text = inputValue;
        if (!text) return;
        onSend(text);
        setComposeText('');
        textareaRef.current?.focus();
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
            className="flex-shrink-0 flex flex-col w-full text-xs font-sans select-none border-t border-border/40"
            style={{
                backgroundColor: resolvedBg,
                color: resolvedFg,
            }}
        >
            {/* SecureCRT Header Bar */}
            <div 
                className="flex items-center h-8 px-2 gap-2 border-b border-border/20"
                style={{
                    backgroundColor: `color-mix(in srgb, ${resolvedFg} 5%, transparent)`,
                }}
            >
                {/* Target Dropdown Selector */}
                {onSendTargetChange && (
                    <Select
                        value={resolvedSendTarget}
                        onValueChange={(value) => onSendTargetChange(value as ComposeSendTarget)}
                    >
                        <SelectTrigger className="h-6 w-auto px-2 bg-black/20 border-border/20 hover:bg-white/5 transition-colors gap-1.5 focus:ring-0 focus:ring-offset-0">
                            <SelectValue placeholder={targetLabel} />
                        </SelectTrigger>
                        <SelectContent className="bg-background border-border/30 z-[1000]">
                            {resolvedTargets.includes('current-split') && (
                                <SelectItem value="current-split">
                                    {getLabel("terminal.composeBar.sendTarget.currentSplit", "Active Session")}
                                </SelectItem>
                            )}
                            {resolvedTargets.includes('current-tab') && (
                                <SelectItem value="current-tab">
                                    {getLabel("terminal.composeBar.sendTarget.currentTab", "Active Tab")}
                                </SelectItem>
                            )}
                            {resolvedTargets.includes('all-sessions') && (
                                <SelectItem value="all-sessions">
                                    {getLabel("terminal.composeBar.sendTarget.allSessions", "All Sessions")}
                                </SelectItem>
                            )}
                        </SelectContent>
                    </Select>
                )}

                <div className="w-px h-3 bg-border/40 mx-1" />

                <div className="flex-1" />

                {/* Right side controls */}
                <div className="flex items-center gap-1">
                    {showBroadcastToggle && (
                        <button
                            onClick={onToggleBroadcast}
                            className={cn(
                                "h-6 px-2 flex items-center gap-1.5 rounded transition-all",
                                isBroadcastEnabled ? "bg-amber-500/10 text-amber-500" : "hover:bg-white/5 opacity-60"
                            )}
                        >
                            <Radio size={12} className={cn(isBroadcastEnabled && "animate-pulse")} />
                            <span className="text-[10px] font-bold uppercase tracking-wider">Broadcast</span>
                        </button>
                    )}

                    <button
                        onClick={onClose}
                        className="h-6 w-6 flex items-center justify-center rounded hover:bg-destructive/10 hover:text-destructive transition-all opacity-50"
                        title={getLabel("terminal.composeBar.close", "Close")}
                    >
                        <X size={14} />
                    </button>
                </div>
            </div>

            {/* Input Area */}
            <div className="relative w-full p-2">
                <textarea
                    ref={textareaRef}
                    className={cn(
                        "w-full resize-none bg-transparent text-[13px] font-mono leading-relaxed",
                        "outline-none transition-all duration-200 block",
                        "placeholder:opacity-20",
                    )}
                    style={{
                        color: resolvedFg,
                        minHeight: '60px',
                        maxHeight: '200px',
                    }}
                    value={inputValue}
                    placeholder={getLabel("terminal.composeBar.placeholder", "Enter commands to send to session...")}
                    onInput={(e) => setComposeText(e.currentTarget.value)}
                    onKeyDown={handleKeyDown}
                    onCompositionStart={() => { isComposingRef.current = true; }}
                    onCompositionEnd={() => { isComposingRef.current = false; }}
                />
                
                {/* Visual Cue: Bottom right send button hint or similar could be added here */}
            </div>
        </div>
    );
};

export default TerminalComposeBar;
