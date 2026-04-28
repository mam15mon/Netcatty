/**
 * Terminal Compose Bar
 * An immersive, borderless prompt bar that blends into the terminal's
 * background — like the Claude Code compose area. Enter sends, Escape
 * closes, Shift+Enter inserts a newline. The only visible chrome is a
 * hair-line top border separating it from the terminal output, while
 * preserving Netcatty's send-target and broadcast controls.
 */
import { Check, Circle, Plus, Radio, Trash2, X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { useStoredNumber } from '../../application/state/useStoredNumber';
import { useStoredString } from '../../application/state/useStoredString';
import { cn } from '../../lib/utils';
import { STORAGE_KEY_TERM_COMPOSE_BAR_HEIGHT, STORAGE_KEY_TERM_COMPOSE_BAR_HISTORY } from '../../infrastructure/config/storageKeys';
import { Snippet } from '../../types';
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from '../ui/context-menu';

import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "../ui/select";

type ComposeSendTarget = 'current-tab' | 'current-split' | 'all-sessions';
const MAX_COMPOSE_HISTORY_ENTRIES = 200;

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
    snippets?: Snippet[];
    snippetPackages?: string[];
    onSnippetExecute?: (command: string, noAutoRun?: boolean) => void;
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
    snippets = [],
    snippetPackages = [],
    onSnippetExecute,
    targetName: _targetName,
}) => {
    const { t } = useI18n();

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

    const packageOptions = useMemo<string[]>(() => {
        const set = new Set<string>();
        snippetPackages.forEach((item) => {
            if (item) set.add(item);
        });
        snippets.forEach((snippet) => {
            if (snippet.package) set.add(snippet.package);
        });
        return Array.from(set).sort((a, b) => a.localeCompare(b));
    }, [snippetPackages, snippets]);
    const allPackagesValue = '__all_packages__';

    const [selectedPackage, setSelectedPackage] = useState('');
    useEffect(() => {
        if (selectedPackage && !packageOptions.includes(selectedPackage)) {
            setSelectedPackage('');
        }
    }, [packageOptions, selectedPackage]);

    const visibleSnippets = useMemo<Snippet[]>(() => {
        const filtered = snippets.filter((snippet) => {
            if (!selectedPackage) return true;
            return (snippet.package || '') === selectedPackage;
        });
        return filtered
            .slice()
            .sort((a, b) => a.label.localeCompare(b.label));
    }, [selectedPackage, snippets]);

    const resolveSnippetIconColor = useCallback((snippet: Snippet) => {
        const color = snippet.iconColor?.trim();
        return color || undefined;
    }, []);

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const isComposingRef = useRef(false);
    const sendLockRef = useRef(false);
    const [internalValue, setInternalValue] = useState('');
    const inputValue = value ?? internalValue;
    const [historyPayload, setHistoryPayload] = useStoredString(
        STORAGE_KEY_TERM_COMPOSE_BAR_HISTORY,
        '[]',
        undefined,
        { maxPersistedLength: 65536 },
    );
    const composeHistory = useMemo<string[]>(() => {
        try {
            const parsed = JSON.parse(historyPayload);
            if (!Array.isArray(parsed)) return [];
            return parsed
                .filter((entry): entry is string => typeof entry === 'string')
                .map((entry) => entry.replace(/\r\n?/g, '\n').trim())
                .filter((entry) => entry.length > 0);
        } catch {
            return [];
        }
    }, [historyPayload]);
    const [historyIndex, setHistoryIndex] = useState<number | null>(null);
    const historyDraftRef = useRef('');

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

    const applyHistoryEntry = useCallback((next: string) => {
        setComposeText(next);
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => {
                const textarea = textareaRef.current;
                if (!textarea) return;
                const end = textarea.value.length;
                textarea.setSelectionRange(end, end);
            });
        }
    }, [setComposeText]);

    const navigateHistory = useCallback((direction: 'up' | 'down') => {
        if (composeHistory.length === 0) return;

        if (direction === 'up') {
            if (historyIndex === null) {
                historyDraftRef.current = inputValue;
                const newest = composeHistory.length - 1;
                setHistoryIndex(newest);
                applyHistoryEntry(composeHistory[newest]);
                return;
            }
            if (historyIndex > 0) {
                const nextIndex = historyIndex - 1;
                setHistoryIndex(nextIndex);
                applyHistoryEntry(composeHistory[nextIndex]);
            }
            return;
        }

        if (historyIndex === null) return;
        if (historyIndex < composeHistory.length - 1) {
            const nextIndex = historyIndex + 1;
            setHistoryIndex(nextIndex);
            applyHistoryEntry(composeHistory[nextIndex]);
            return;
        }

        setHistoryIndex(null);
        applyHistoryEntry(historyDraftRef.current);
        historyDraftRef.current = '';
    }, [applyHistoryEntry, composeHistory, historyIndex, inputValue]);

    useEffect(() => {
        if (historyIndex !== null && historyIndex >= composeHistory.length) {
            setHistoryIndex(composeHistory.length > 0 ? composeHistory.length - 1 : null);
        }
    }, [composeHistory.length, historyIndex]);

    const handleSend = useCallback(() => {
        if (sendLockRef.current) return;
        sendLockRef.current = true;
        const text = inputValue;
        const normalizedHistoryEntry = text.replace(/\r\n?/g, '\n').trim();
        if (normalizedHistoryEntry) {
            const latestEntry = composeHistory[composeHistory.length - 1];
            if (latestEntry !== normalizedHistoryEntry) {
                const nextHistory = [...composeHistory, normalizedHistoryEntry];
                const boundedHistory = nextHistory.length > MAX_COMPOSE_HISTORY_ENTRIES
                    ? nextHistory.slice(nextHistory.length - MAX_COMPOSE_HISTORY_ENTRIES)
                    : nextHistory;
                setHistoryPayload(JSON.stringify(boundedHistory));
            }
        }
        onSend(text);
        setComposeText('');
        setHistoryIndex(null);
        historyDraftRef.current = '';
        textareaRef.current?.focus();
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => {
                sendLockRef.current = false;
            });
        } else {
            setTimeout(() => {
                sendLockRef.current = false;
            }, 0);
        }
    }, [composeHistory, inputValue, onSend, setComposeText, setHistoryPayload]);

    const handleSnippetExecute = useCallback((snippet: Snippet) => {
        if (onSnippetExecute) {
            onSnippetExecute(snippet.command, snippet.noAutoRun);
        } else {
            onSend(snippet.command);
        }
        textareaRef.current?.focus();
    }, [onSend, onSnippetExecute]);

    const handleEditSnippetInline = useCallback((snippet: Snippet) => {
        setComposeText(snippet.command);
        textareaRef.current?.focus();
    }, [setComposeText]);

    const handleEditSnippet = useCallback((snippet: Snippet) => {
        window.dispatchEvent(
            new CustomEvent('netcatty:snippets:edit', { detail: { snippet } }),
        );
    }, []);

    const handleAddSnippet = useCallback(() => {
        window.dispatchEvent(new CustomEvent('netcatty:snippets:add'));
    }, []);

    const handleDeleteSnippet = useCallback((snippetId: string) => {
        window.dispatchEvent(new CustomEvent('netcatty:snippets:delete', { detail: { id: snippetId } }));
    }, []);

    const [composeHeight, setComposeHeight, persistComposeHeight] = useStoredNumber(
        STORAGE_KEY_TERM_COMPOSE_BAR_HEIGHT,
        120,
        { min: 60, max: 600 },
    );
    const [resizing, setResizing] = useState(false);
    const composeHeightRef = useRef(composeHeight);
    const isResizing = useRef(false);

    const handleMouseMove = useCallback((e: MouseEvent) => {
        if (!isResizing.current) return;
        // The bar is at the bottom, so we increase height as mouse moves UP (smaller clientY)
        const newHeight = window.innerHeight - e.clientY;
        if (newHeight >= 60 && newHeight <= 600) {
            setComposeHeight(newHeight);
        }
    }, [setComposeHeight]);

    const stopResizing = useCallback(() => {
        isResizing.current = false;
        setResizing(false);
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', stopResizing);
        document.body.style.cursor = '';
        persistComposeHeight(composeHeightRef.current);
    }, [handleMouseMove, persistComposeHeight]);

    const startResizing = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        isResizing.current = true;
        setResizing(true);
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', stopResizing);
        document.body.style.cursor = 'ns-resize';
    }, [handleMouseMove, stopResizing]);

    useEffect(() => {
        composeHeightRef.current = composeHeight;
    }, [composeHeight]);

    useEffect(() => () => stopResizing(), [stopResizing]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (
            (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
            !isComposingRef.current &&
            !e.shiftKey &&
            !e.ctrlKey &&
            !e.metaKey &&
            !e.altKey
        ) {
            const textarea = e.currentTarget;
            const selectionStart = textarea.selectionStart ?? 0;
            const selectionEnd = textarea.selectionEnd ?? 0;
            if (selectionStart === selectionEnd) {
                const before = textarea.value.slice(0, selectionStart);
                const after = textarea.value.slice(selectionStart);
                const isAtFirstLine = !before.includes('\n');
                const isAtLastLine = !after.includes('\n');
                if ((e.key === 'ArrowUp' && isAtFirstLine) || (e.key === 'ArrowDown' && isAtLastLine)) {
                    e.preventDefault();
                    navigateHistory(e.key === 'ArrowUp' ? 'up' : 'down');
                    return;
                }
            }
        }
        if (e.key === 'Enter' && !e.shiftKey && !isComposingRef.current) {
            e.preventDefault();
            handleSend();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
        }
    }, [handleSend, navigateHistory, onClose]);

    const bg = themeColors?.background ?? '#0a0a0a';
    const fg = themeColors?.foreground ?? '#d4d4d4';
    const resolvedBg = 'var(--terminal-ui-bg, ' + bg + ')';
    const resolvedFg = 'var(--terminal-ui-fg, ' + fg + ')';

    return (
        <div
            className="flex-shrink-0 flex flex-col w-full text-xs font-sans select-none relative"
            style={{
                backgroundColor: resolvedBg,
                color: resolvedFg,
                borderTop: `1px solid color-mix(in srgb, ${resolvedFg} 8%, ${resolvedBg} 92%)`,
                height: `${composeHeight}px`,
            }}
        >
            {/* Resize Handle */}
            <div
                className="absolute -top-1 left-0 right-0 h-2 cursor-ns-resize z-50 group"
                onMouseDown={startResizing}
            >
                <div 
                    className={cn(
                        "absolute left-0 right-0 h-px bg-primary/60 transition-opacity",
                        resizing ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                    )}
                    style={{ top: '50%', transform: 'translateY(-50%)' }}
                />
            </div>

            <ContextMenu>
                <ContextMenuTrigger asChild>
                    <div
                        className="flex items-center h-9 px-3 gap-2"
                        style={{
                            backgroundColor: `color-mix(in srgb, ${resolvedFg} 5%, transparent)`,
                        }}
                    >
                        <Select
                            value={selectedPackage || allPackagesValue}
                            onValueChange={(value) => setSelectedPackage(value === allPackagesValue ? '' : value)}
                        >
                            <SelectTrigger className="h-6 w-auto px-3 rounded-full bg-black/20 border-border/20 hover:bg-white/5 transition-colors gap-1.5 focus:ring-0 focus:ring-offset-0 text-[10px] font-medium tracking-wide flex items-center [&>span]:translate-y-[1.5px]">
                                <SelectValue placeholder={getLabel('snippets.breadcrumb.allPackages', 'All Packages')} />
                            </SelectTrigger>
                            <SelectContent className="bg-background border-border/30 z-[1000]">
                                <SelectItem value={allPackagesValue} className="text-[10px] font-medium tracking-wide">
                                    {getLabel('snippets.breadcrumb.allPackages', 'All Packages')}
                                </SelectItem>
                                {packageOptions.map((item) => (
                                    <SelectItem key={item} value={item} className="text-[10px] font-medium tracking-wide">
                                        {item}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>

                        <div className="w-px h-3 bg-border/40 mx-1" />
                        <div className="min-w-0 flex-1 overflow-x-auto">
                            <div className="flex items-center gap-1.5 min-w-max pr-2">
                                {visibleSnippets.length > 0 ? (
                                    visibleSnippets.map((snippet) => (
                                        <ContextMenu key={snippet.id}>
                                            <ContextMenuTrigger asChild>
                                                <button
                                                    type="button"
                                                    onClick={() => handleSnippetExecute(snippet)}
                                                    className="h-6 w-auto px-3 rounded-full bg-black/20 border border-border/20 hover:bg-white/5 transition-colors gap-1.5 focus:ring-0 focus:ring-offset-0 text-[10px] font-medium tracking-wide flex items-center [&>span]:translate-y-[1.5px]"
                                                    title={snippet.command}
                                                >
                                                    <Circle
                                                        size={12}
                                                        fill="currentColor"
                                                        className={cn(!resolveSnippetIconColor(snippet) && "opacity-70")}
                                                        style={resolveSnippetIconColor(snippet) ? { color: resolveSnippetIconColor(snippet) } : undefined}
                                                    />
                                                    <span className="max-w-[140px] truncate">{snippet.label}</span>
                                                </button>
                                            </ContextMenuTrigger>
                                            <ContextMenuContent>
                                                <ContextMenuItem onClick={() => handleSnippetExecute(snippet)} className="text-[10px] font-medium tracking-wide">
                                                    <span className="translate-y-[1px]">{getLabel('action.run', 'Run')}</span>
                                                </ContextMenuItem>
                                                <ContextMenuItem onClick={() => handleEditSnippetInline(snippet)} className="text-[10px] font-medium tracking-wide">
                                                    <span className="translate-y-[1px]">{getLabel('snippets.action.editInline', 'Edit In Composer')}</span>
                                                </ContextMenuItem>
                                                <ContextMenuItem onClick={() => handleEditSnippet(snippet)} className="text-[10px] font-medium tracking-wide">
                                                    <span className="translate-y-[1px]">{getLabel('action.edit', 'Edit')}</span>
                                                </ContextMenuItem>
                                                <ContextMenuSeparator />
                                                <ContextMenuItem
                                                    className="text-destructive text-[10px] font-medium tracking-wide"
                                                    onClick={() => handleDeleteSnippet(snippet.id)}
                                                >
                                                    <Trash2 className="mr-2 h-3 w-3" />
                                                    <span className="translate-y-[1px]">{getLabel('action.delete', 'Delete')}</span>
                                                </ContextMenuItem>
                                            </ContextMenuContent>
                                        </ContextMenu>
                                    ))
                                ) : (
                                    <span className="text-[10px] text-muted-foreground select-none">
                                        {getLabel('terminal.toolbar.noSnippets', 'No snippets available')}
                                    </span>
                                )}
                            </div>
                        </div>

                        <div className="flex items-center gap-1">
                            {showBroadcastToggle && (
                                <button
                                    onClick={onToggleBroadcast}
                                    className={cn(
                                        "h-6 px-3 flex items-center gap-1.5 rounded-full transition-all",
                                        isBroadcastEnabled ? "bg-amber-500/10 text-amber-500" : "hover:bg-white/5 opacity-60"
                                    )}
                                >
                                    <Radio size={12} className={cn(isBroadcastEnabled && "animate-pulse")} />
                                    <span className="text-[10px] font-bold uppercase tracking-wider">Broadcast</span>
                                </button>
                            )}

                            <button
                                onClick={onClose}
                                className="h-6 w-6 flex items-center justify-center rounded-full hover:bg-destructive/10 hover:text-destructive transition-all opacity-50"
                                title={getLabel("terminal.composeBar.close", "Close")}
                            >
                                <X size={14} />
                            </button>
                        </div>
                    </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                    <ContextMenuItem onClick={handleAddSnippet} className="text-[10px] font-medium tracking-wide">
                        <Plus className="mr-2 h-3 w-3" />
                        <span className="translate-y-[1px]">{getLabel('snippets.menu.newButton', 'New Button...')}</span>
                    </ContextMenuItem>
                </ContextMenuContent>
            </ContextMenu>

            <div className="relative w-full px-3 py-2 flex-1 min-h-0">
                <ContextMenu>
                    <ContextMenuTrigger asChild>
                        <textarea
                            ref={textareaRef}
                            className={cn(
                                "w-full h-full resize-none bg-transparent text-[13px] font-mono leading-relaxed",
                                "outline-none transition-all duration-200 block border-none scrollbar-thin",
                                "placeholder:opacity-70",
                            )}
                            style={{
                                color: resolvedFg,
                            }}
                            value={inputValue}
                            placeholder={`${getLabel("terminal.composeBar.placeholder", "Send command to")} ${targetLabel}...`}
                            onInput={(e) => {
                                if (historyIndex !== null) {
                                    setHistoryIndex(null);
                                    historyDraftRef.current = '';
                                }
                                setComposeText(e.currentTarget.value);
                            }}
                            onKeyDown={handleKeyDown}
                            onCompositionStart={() => { isComposingRef.current = true; }}
                            onCompositionEnd={() => { isComposingRef.current = false; }}
                        />
                    </ContextMenuTrigger>
                    {onSendTargetChange && (
                        <ContextMenuContent>
                            {resolvedTargets.map((target) => {
                                const selected = target === resolvedSendTarget;
                                const label = target === 'current-split'
                                    ? getLabel("terminal.composeBar.sendTarget.currentSplit", "Active Session")
                                    : target === 'current-tab'
                                        ? getLabel("terminal.composeBar.sendTarget.currentTab", "Active Tab")
                                        : getLabel("terminal.composeBar.sendTarget.allSessions", "All Sessions");
                                return (
                                    <ContextMenuItem key={target} onClick={() => onSendTargetChange(target)} className={cn("text-[10px] font-medium tracking-wide", selected && "font-bold text-primary")}>
                                        <Check className={cn("mr-2 h-3 w-3", selected ? "opacity-100" : "opacity-0")} />
                                        <span className="translate-y-[1px]">{label}</span>
                                    </ContextMenuItem>
                                );
                            })}
                        </ContextMenuContent>
                    )}
                </ContextMenu>
            </div>
        </div>
    );
};

export default TerminalComposeBar;
