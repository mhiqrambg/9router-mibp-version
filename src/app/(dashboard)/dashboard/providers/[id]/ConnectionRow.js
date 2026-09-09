"use client";

import { useState, useEffect, useRef } from "react";
import { getStatusVariant as getConnectionStatusVariant } from "@/shared/utils/connectionStatus";
import PropTypes from "prop-types";
import { Badge, Toggle, Tooltip } from "@/shared/components";
import CooldownTimer from "./CooldownTimer";

export default function ConnectionRow({ connection, proxyPools, isOAuth, isFirst, isLast, onMoveUp, onMoveDown, onToggleActive, onUpdateProxy, onEdit, onDelete, oneByOneStatus = null, autoPing = null, modelAssignmentOptions = null, onModelAssignmentChange = null, strictModelAssignment = false }) {
  const [showProxyDropdown, setShowProxyDropdown] = useState(false);
  const [updatingProxy, setUpdatingProxy] = useState(false);
  const [selectedProxyIds, setSelectedProxyIds] = useState([]);
  const [rotationStrategy, setRotationStrategy] = useState("none");
  const proxyDropdownRef = useRef(null);

  // Initialize proxy state from connection
  useEffect(() => {
    const proxyPoolIds = connection.providerSpecificData?.proxyPoolIds || [];
    const legacyProxyPoolId = connection.providerSpecificData?.proxyPoolId;
    
    // Migrate legacy single proxy to array format
    queueMicrotask(() => {
      if (legacyProxyPoolId && proxyPoolIds.length === 0) {
        setSelectedProxyIds([legacyProxyPoolId]);
      } else {
        setSelectedProxyIds(proxyPoolIds);
      }
      setRotationStrategy(connection.providerSpecificData?.proxyRotationStrategy || "none");
    });
  }, [connection]);

  const proxyPoolMap = new Map((proxyPools || []).map((pool) => [pool.id, pool]));
  
  // Display logic - support both new (multi-proxy) and legacy (single proxy) formats
  const hasLegacyProxy = connection.providerSpecificData?.connectionProxyEnabled === true && !!connection.providerSpecificData?.connectionProxyUrl;
  const hasAnyProxy = selectedProxyIds.length > 0 || hasLegacyProxy;
  
  const getProxyDisplayText = () => {
    if (selectedProxyIds.length === 0 && !hasLegacyProxy) return "";
    
    if (selectedProxyIds.length === 1) {
      const pool = proxyPoolMap.get(selectedProxyIds[0]);
      return pool ? `Pool: ${pool.name}` : `Pool: ${selectedProxyIds[0]} (inactive/missing)`;
    }
    
    if (selectedProxyIds.length > 1) {
      const strategyLabel = rotationStrategy === "random" ? "Random" : rotationStrategy === "round-robin" ? "Round Robin" : rotationStrategy === "failover" ? "Failover" : rotationStrategy === "smart" ? "Smart" : "Multiple";
      return `${selectedProxyIds.length} pools (${strategyLabel})`;
    }
    
    if (hasLegacyProxy) {
      return `Legacy: ${connection.providerSpecificData?.connectionProxyUrl}`;
    }
    
    return "";
  };
  
  const proxyDisplayText = getProxyDisplayText();
  const autoPingTooltip = autoPing?.provider === "codex"
    ? "Auto-starts the next 5h Codex window after reset by sending a tiny gpt-5.5 request. Consumes a small amount of quota."
    : "When your 5h quota runs out, auto-sends a request the moment it resets so a new window starts right away.";

  let maskedProxyUrl = "";
  if (selectedProxyIds.length > 0) {
    const selectedPools = selectedProxyIds.map(id => proxyPoolMap.get(id)).filter(Boolean);
    if (selectedPools.length > 0) {
      try {
        const parsed = new URL(selectedPools[0].proxyUrl);
        maskedProxyUrl = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
        if (selectedPools.length > 1) {
          maskedProxyUrl += ` (+${selectedPools.length - 1} more)`;
        }
      } catch {
        maskedProxyUrl = selectedPools[0].proxyUrl;
      }
    }
  } else if (connection.providerSpecificData?.connectionProxyUrl) {
    const rawProxyUrl = connection.providerSpecificData?.connectionProxyUrl;
    try {
      const parsed = new URL(rawProxyUrl);
      maskedProxyUrl = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
    } catch {
      maskedProxyUrl = rawProxyUrl;
    }
  }

  const noProxyText = selectedProxyIds.length > 0 
    ? proxyPoolMap.get(selectedProxyIds[0])?.noProxy || ""
    : connection.providerSpecificData?.connectionNoProxy || "";

  let proxyBadgeVariant = "default";
  if (selectedProxyIds.length > 0) {
    const allActive = selectedProxyIds.every(id => proxyPoolMap.get(id)?.isActive === true);
    proxyBadgeVariant = allActive ? "success" : "error";
  } else if (hasLegacyProxy) {
    proxyBadgeVariant = "error";
  }

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!showProxyDropdown) return;
    const handler = (e) => {
      if (proxyDropdownRef.current && !proxyDropdownRef.current.contains(e.target)) {
        setShowProxyDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showProxyDropdown]);

  const handleToggleProxySelection = (poolId) => {
    setSelectedProxyIds(prev => {
      if (prev.includes(poolId)) {
        return prev.filter(id => id !== poolId);
      } else {
        return [...prev, poolId];
      }
    });
  };

  const handleStrategyChange = (strategy) => {
    setRotationStrategy(strategy);
    
    // Auto-select all active proxy pools when switching to rotation strategies
    if (strategy !== "none" && selectedProxyIds.length === 0) {
      const activePoolIds = (proxyPools || [])
        .filter(pool => pool.isActive === true)
        .map(pool => pool.id);
      setSelectedProxyIds(activePoolIds);
    }
    
    // Reset to single proxy when switching to "none"
    if (strategy === "none" && selectedProxyIds.length > 1) {
      setSelectedProxyIds(selectedProxyIds.slice(0, 1));
    }
  };

  const handleApplyProxyChanges = async () => {
    setUpdatingProxy(true);
    try {
      await onUpdateProxy({
        proxyPoolIds: selectedProxyIds,
        proxyRotationStrategy: rotationStrategy,
      });
      setShowProxyDropdown(false);
    } finally {
      setUpdatingProxy(false);
    }
  };

  const handleSelectProxy = async (poolId) => {
    // Legacy single-proxy mode (backwards compatibility)
    setUpdatingProxy(true);
    try {
      await onUpdateProxy({
        proxyPoolIds: poolId === "__none__" ? [] : [poolId],
        proxyRotationStrategy: "none",
      });
    } finally {
      setUpdatingProxy(false);
      setShowProxyDropdown(false);
    }
  };

  const rowAuthType = connection.authType || (isOAuth ? "oauth" : "apikey");
  const isOAuthConnection = rowAuthType === "oauth";
  const isCookieConnection = rowAuthType === "cookie";
  const authIcon = isCookieConnection ? "cookie" : isOAuthConnection ? "lock" : "key";
  const authLabel = isOAuthConnection ? "OAuth" : isCookieConnection ? "Cookie" : "API Key";
  const isEmail = (v) => typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  const isUuid = (v) =>
    typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim());
  const defaultOAuthLabel = isEmail(connection.email)
    ? connection.email
    : isEmail(connection.name)
      ? connection.name
      : (connection.name || connection.email || connection.displayName || "OAuth Account");
  const glmOAuthLabel = (() => {
    for (const value of [connection.email, connection.name, connection.displayName]) {
      if (isEmail(value)) return value;
    }
    for (const value of [connection.email, connection.name, connection.displayName]) {
      if (typeof value === "string" && value.trim() && !isUuid(value)) return value.trim();
    }
    return "OAuth Account";
  })();
  const displayName = isOAuthConnection
    ? (connection.provider === "glm" ? glmOAuthLabel : defaultOAuthLabel)
    : (connection.name || connection.email || connection.displayName || "API Key");


  // Use useState + useEffect for impure Date.now() to avoid calling during render
  const [isCooldown, setIsCooldown] = useState(false);

  // Get earliest model lock timestamp (useEffect handles the Date.now() comparison)
  const modelLockUntil = Object.entries(connection)
    .filter(([k]) => k.startsWith("modelLock_"))
    .map(([, v]) => v)
    .filter(v => !!v)
    .sort()[0] || null;

  useEffect(() => {
    const checkCooldown = () => {
      const until = Object.entries(connection)
        .filter(([k]) => k.startsWith("modelLock_"))
        .map(([, v]) => v)
        .filter(v => v && new Date(v).getTime() > Date.now())
        .sort()[0] || null;
      setIsCooldown(!!until);
    };

    checkCooldown();
    const interval = modelLockUntil ? setInterval(checkCooldown, 1000) : null;
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [connection, modelLockUntil]);

  // Determine effective status (override unavailable if cooldown expired)
  const effectiveStatus = (connection.testStatus === "unavailable" && !isCooldown)
    ? "active"  // Cooldown expired u2192 treat as active
    : connection.testStatus;

  const getStatusVariant = () => getConnectionStatusVariant(connection.isActive, effectiveStatus);

  const getOneByOneVariant = () => {
    if (!oneByOneStatus) return "default";
    if (oneByOneStatus.state === "success") return "success";
    if (oneByOneStatus.state === "failed") return "error";
    if (oneByOneStatus.state === "testing") return "primary";
    return "default";
  };

  const getOneByOneLabel = () => {
    if (!oneByOneStatus) return null;
    if (oneByOneStatus.state === "queued") return "queued";
    if (oneByOneStatus.state === "testing") return "testing";
    if (oneByOneStatus.state === "success") return "success";
    if (oneByOneStatus.state === "failed") return oneByOneStatus.error ? `failed: ${oneByOneStatus.error}` : "failed";
    return null;
  };

  return (
    <div className={`group flex min-w-0 flex-col gap-3 rounded-lg p-2 transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.02] sm:flex-row sm:items-center sm:justify-between ${connection.isActive === false ? "opacity-60" : ""}`}>
      <div className="flex min-w-0 flex-1 items-start gap-2 sm:items-center sm:gap-3">
        {/* Priority arrows */}
        <div className="flex shrink-0 flex-col">
          <button
            onClick={onMoveUp}
            disabled={isFirst}
            className={`p-0.5 rounded ${isFirst ? "text-text-muted/30 cursor-not-allowed" : "hover:bg-sidebar text-text-muted hover:text-primary"}`}
          >
            <span className="material-symbols-outlined text-sm">keyboard_arrow_up</span>
          </button>
          <button
            onClick={onMoveDown}
            disabled={isLast}
            className={`p-0.5 rounded ${isLast ? "text-text-muted/30 cursor-not-allowed" : "hover:bg-sidebar text-text-muted hover:text-primary"}`}
          >
            <span className="material-symbols-outlined text-sm">keyboard_arrow_down</span>
          </button>
        </div>
        <span className="material-symbols-outlined shrink-0 text-base text-text-muted">
          {authIcon}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{displayName}</p>
          {secondaryDisplayName && (
            <p className="text-xs text-text-muted truncate">{secondaryDisplayName}</p>
          )}
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 sm:gap-2">
            <Badge variant={getStatusVariant()} size="sm" dot>
              {connection.isActive === false ? "disabled" : (effectiveStatus || "Unknown")}
            </Badge>
            <Badge variant="default" size="sm">
              {authLabel}
            </Badge>
            {hasAnyProxy && (
              <Badge variant={proxyBadgeVariant} size="sm">
                Proxy
              </Badge>
            )}
            {isCooldown && connection.isActive !== false && <CooldownTimer until={modelLockUntil} />}
            {connection.lastError && connection.isActive !== false && (
              <span className="max-w-full truncate text-xs text-red-500 sm:max-w-[300px]" title={connection.lastError}>
                {connection.lastError}
              </span>
            )}
            <span className="text-xs text-text-muted">#{connection.priority}</span>
            {connection.globalPriority && (
              <span className="text-xs text-text-muted">Auto: {connection.globalPriority}</span>
            )}
            {getOneByOneLabel() && (
              <Badge variant={getOneByOneVariant()} size="sm">
                {getOneByOneLabel()}
              </Badge>
            )}
          </div>
           {modelAssignmentOptions && onModelAssignmentChange && (
             <select
               value={connection.providerSpecificData?.assignedModel || connection.providerSpecificData?.freebuffModel || ""}
              onChange={(e) => onModelAssignmentChange(e.target.value)}
              disabled={!strictModelAssignment}
               className="mt-2 max-w-full rounded-md border border-border bg-background px-2 py-1 text-[11px] text-text-main"
               title="Model assignment"
             >
               <option value="">Unassigned</option>
               {modelAssignmentOptions.map((model) => (
                <option key={model.id} value={model.id}>{model.name || model.id}</option>
              ))}
            </select>
          )}
          {hasAnyProxy && (
            <div className="mt-1 flex items-center gap-2 flex-wrap">
              <span className="max-w-full truncate text-[11px] text-text-muted sm:max-w-[420px]" title={proxyDisplayText}>
                {proxyDisplayText}
              </span>
              {maskedProxyUrl && (
                <code className="max-w-full truncate rounded bg-black/5 px-1 py-0.5 font-mono text-[10px] text-text-muted dark:bg-white/5 sm:max-w-[260px]">
                  {maskedProxyUrl}
                </code>
              )}
              {noProxyText && (
                <span className="max-w-full truncate text-[11px] text-text-muted sm:max-w-[320px]" title={noProxyText}>
                  no_proxy: {noProxyText}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="flex w-full items-center justify-between gap-2 sm:w-auto sm:justify-end">
        <div className="grid flex-1 grid-cols-3 gap-1 sm:flex sm:flex-none">
          {/* Proxy button with inline dropdown */}
          {(proxyPools || []).length > 0 && (
            <div className="relative" ref={proxyDropdownRef}>
              <button
                onClick={() => setShowProxyDropdown((v) => !v)}
                className={`flex w-full flex-col items-center rounded px-2 py-1 transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${hasAnyProxy ? "text-primary" : "text-text-muted hover:text-primary"}`}
                disabled={updatingProxy}
              >
                <span className="material-symbols-outlined text-[18px]">
                  {updatingProxy ? "progress_activity" : "lan"}
                </span>
                <span className="text-[10px] leading-tight">Proxy</span>
              </button>
              {showProxyDropdown && (
                <div className="absolute left-0 top-full z-50 mt-1 max-w-[calc(100vw-2rem)] min-w-[280px] rounded-lg border border-border bg-bg shadow-lg sm:left-auto sm:right-0">
                  {/* Rotation Strategy Selector */}
                  <div className="border-b border-border p-3">
                    <label className="block text-xs font-medium text-text-muted mb-2">Rotation Strategy</label>
                    <select
                      value={rotationStrategy}
                      onChange={(e) => handleStrategyChange(e.target.value)}
                      className="w-full rounded border border-border bg-bg px-2 py-1.5 text-sm text-text-main focus:border-primary focus:outline-none"
                    >
                      <option value="none">None (Single Proxy)</option>
                      <option value="random">Random</option>
                      <option value="round-robin">Round Robin</option>
                      <option value="failover">Failover</option>
                      <option value="smart">Smart</option>
                    </select>
                    {rotationStrategy !== "none" && (
                      <p className="mt-1 text-[10px] text-text-muted">
                        {rotationStrategy === "random" && "Randomly select proxy on each request"}
                        {rotationStrategy === "round-robin" && "Rotate proxies in order across requests"}
                        {rotationStrategy === "failover" && "Try next proxy on failure"}
                        {rotationStrategy === "smart" && "Skip pools whose egress IP is blocked for this provider/model (e.g. Freebuff limited-IP). See Proxy Fitness to clear/block."}
                      </p>
                    )}
                  </div>

                  {/* Proxy Pool Selection */}
                  <div className="max-h-[200px] overflow-y-auto py-1">
                    <button
                      onClick={() => {
                        setSelectedProxyIds([]);
                        setRotationStrategy("none");
                      }}
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/5 ${selectedProxyIds.length === 0 ? "text-primary font-medium" : "text-text-main"}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-[16px]">
                          {selectedProxyIds.length === 0 ? "check_box" : "check_box_outline_blank"}
                        </span>
                        <span>None</span>
                      </div>
                    </button>
                    
                    {/* Select All Button (only for rotation strategies) */}
                    {rotationStrategy !== "none" && (
                      <button
                        onClick={() => {
                          const activePoolIds = (proxyPools || [])
                            .filter(pool => pool.isActive === true)
                            .map(pool => pool.id);
                          const allSelected = activePoolIds.length > 0 && activePoolIds.every(id => selectedProxyIds.includes(id));
                          
                          if (allSelected) {
                            setSelectedProxyIds([]);
                          } else {
                            setSelectedProxyIds(activePoolIds);
                          }
                        }}
                        className={`w-full text-left px-3 py-2 text-sm border-b border-border hover:bg-black/5 dark:hover:bg-white/5 ${selectedProxyIds.length === (proxyPools || []).filter(p => p.isActive).length ? "bg-black/5 dark:bg-white/5" : ""}`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="material-symbols-outlined text-[16px]">
                            {selectedProxyIds.length === (proxyPools || []).filter(p => p.isActive).length && selectedProxyIds.length > 0
                              ? "check_box"
                              : "check_box_outline_blank"
                            }
                          </span>
                          <span className="font-medium">Select All Active</span>
                        </div>
                      </button>
                    )}
                    
                    {(proxyPools || []).map((pool) => {
                      const isSelected = selectedProxyIds.includes(pool.id);
                      const isActive = pool.isActive === true;
                      return (
                        <button
                          key={pool.id}
                          onClick={() => {
                            if (rotationStrategy === "none") {
                              setSelectedProxyIds([pool.id]);
                            } else {
                              handleToggleProxySelection(pool.id);
                            }
                          }}
                          className={`w-full text-left px-3 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/5 ${isSelected ? "bg-black/5 dark:bg-white/5" : ""}`}
                        >
                          <div className="flex items-center gap-2">
                            <span className="material-symbols-outlined text-[16px]">
                              {rotationStrategy === "none" 
                                ? (isSelected ? "radio_button_checked" : "radio_button_unchecked")
                                : (isSelected ? "check_box" : "check_box_outline_blank")
                              }
                            </span>
                            <span className={isSelected ? "text-primary font-medium" : "text-text-main"}>{pool.name}</span>
                            {!isActive && (
                              <span className="ml-auto text-[10px] text-red-500">(inactive)</span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  {/* Apply Button */}
                  <div className="border-t border-border p-2">
                    <button
                      onClick={handleApplyProxyChanges}
                      disabled={updatingProxy}
                      className="w-full rounded bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {updatingProxy ? "Applying..." : "Apply"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {autoPing && (
            <Tooltip text={autoPingTooltip}>
              <button
                onClick={() => autoPing.onToggle(!autoPing.on)}
                className={`flex w-full flex-col items-center rounded px-2 py-1 transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${autoPing.on ? "text-primary" : "text-text-muted hover:text-primary"}`}
              >
                <span className="material-symbols-outlined text-[18px]">bolt</span>
                <span className="text-[10px] leading-tight">Auto-ping</span>
              </button>
            </Tooltip>
          )}
          <button onClick={onEdit} className="flex flex-col items-center rounded px-2 py-1 text-text-muted hover:bg-black/5 hover:text-primary dark:hover:bg-white/5">
            <span className="material-symbols-outlined text-[18px]">edit</span>
            <span className="text-[10px] leading-tight">Edit</span>
          </button>
          <button onClick={onDelete} className="flex flex-col items-center rounded px-2 py-1 text-red-500 hover:bg-red-500/10">
            <span className="material-symbols-outlined text-[18px]">delete</span>
            <span className="text-[10px] leading-tight">Delete</span>
          </button>
        </div>
        <Toggle
          size="sm"
          checked={connection.isActive ?? true}
          onChange={onToggleActive}
          title={(connection.isActive ?? true) ? "Disable connection" : "Enable connection"}
        />
      </div>
    </div>
  );
}

ConnectionRow.propTypes = {
  connection: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    email: PropTypes.string,
    displayName: PropTypes.string,
    modelLockUntil: PropTypes.string,
    testStatus: PropTypes.string,
    isActive: PropTypes.bool,
    lastError: PropTypes.string,
    priority: PropTypes.number,
    globalPriority: PropTypes.number,
  }).isRequired,
  proxyPools: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    proxyUrl: PropTypes.string,
    noProxy: PropTypes.string,
    isActive: PropTypes.bool,
  })),
  isOAuth: PropTypes.bool.isRequired,
  isFirst: PropTypes.bool.isRequired,
  isLast: PropTypes.bool.isRequired,
  onMoveUp: PropTypes.func.isRequired,
  onMoveDown: PropTypes.func.isRequired,
  onToggleActive: PropTypes.func.isRequired,
  onUpdateProxy: PropTypes.func,
  onEdit: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired,
  modelAssignmentOptions: PropTypes.arrayOf(PropTypes.shape({ id: PropTypes.string.isRequired, name: PropTypes.string })),
  onModelAssignmentChange: PropTypes.func,
  strictModelAssignment: PropTypes.bool,
  oneByOneStatus: PropTypes.shape({
    state: PropTypes.string,
    error: PropTypes.string,
  }),
  autoPing: PropTypes.shape({
    on: PropTypes.bool,
    onToggle: PropTypes.func,
    provider: PropTypes.string,
  }),
};
