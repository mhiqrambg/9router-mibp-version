"use client";

// Per-API-key access control on the Endpoint page.
// "Restrict access" toggle per key; when on, the key may call only the listed
// combos/models. At most PREVIEW_LIMIT entries are shown inline as removable
// badges; the rest live behind "+N more" so a "select all" cannot overflow the
// key row. Entries are picked with the same shared ModelSelectModal the combo
// editor uses (combos first, then models).
import { useState } from "react";
import PropTypes from "prop-types";
import { Toggle, ModelSelectModal, Modal, Button } from "@/shared/components";
import { KEY_ACCESS_MAX_ENTRIES } from "@/shared/constants/keyAccess.js";
import { addAllowEntries, removeAllowEntries } from "@/shared/utils/keyAccess.js";

const PREVIEW_LIMIT = 3;

export default function KeyAccessControls({ apiKey, onChange, onRequestRestrict }) {
  const access = apiKey.access || { restricted: false, allow: [] };
  const [pickerOpen, setPickerOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [activeProviders, setActiveProviders] = useState([]);
  const [modelAliases, setModelAliases] = useState({});

  const openPicker = async () => {
    setPickerOpen(true);
    // Same sources the combo editor feeds the picker with.
    try {
      const [providersRes, aliasRes] = await Promise.all([fetch("/api/providers"), fetch("/api/models/alias")]);
      if (providersRes.ok) setActiveProviders((await providersRes.json()).connections || []);
      if (aliasRes.ok) setModelAliases((await aliasRes.json()).aliases || {});
    } catch (error) {
      console.log("Error loading picker data:", error);
    }
  };

  const setAllow = (allow) => onChange({ restricted: true, allow });

  // Batch add/remove so "select all" (one call per model in the picker) cannot
  // act on a stale allow list and drop all but the last selection.
  const addMany = (models) => {
    const values = (Array.isArray(models) ? models : [models]).map((m) => m?.value).filter(Boolean);
    if (values.length === 0) return;
    const next = addAllowEntries(access.allow, values);
    if (next.length !== access.allow.length) setAllow(next);
  };

  const removeMany = (models) => {
    const values = (Array.isArray(models) ? models : [models]).map((m) => m?.value ?? m).filter(Boolean);
    if (values.length === 0) return;
    const next = removeAllowEntries(access.allow, values);
    if (next.length !== access.allow.length) setAllow(next);
  };

  const remove = (value) => removeMany([value]);
  const atLimit = access.allow.length >= KEY_ACCESS_MAX_ENTRIES;
  const visible = access.allow.slice(0, PREVIEW_LIMIT);
  const hiddenCount = access.allow.length - visible.length;

  const renderChip = (entry) => (
    <span
      key={entry}
      className="flex min-w-0 max-w-[240px] items-center gap-1 rounded-xl border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-xs text-text-main"
    >
      <span className="truncate" title={entry}>{entry}</span>
      <button
        onClick={() => remove(entry)}
        className="shrink-0 rounded text-text-muted hover:text-red-500"
        title={`Remove ${entry}`}
        aria-label={`Remove ${entry}`}
      >
        <span className="material-symbols-outlined leading-none" style={{ fontSize: "12px" }}>close</span>
      </button>
    </span>
  );

  return (
    <div className="mt-2 min-w-0" data-testid="key-access">
      <Toggle
        size="sm"
        checked={access.restricted}
        label="Restrict access"
        onChange={(checked) => (checked ? onRequestRestrict() : onChange({ restricted: false, allow: access.allow }))}
      />
      {access.restricted && (
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
          {access.allow.length === 0 && (
            <span className="text-xs text-orange-500">No combos or models allowed — this key can call nothing.</span>
          )}
          {visible.map(renderChip)}
          {hiddenCount > 0 && (
            <button
              onClick={() => setListOpen(true)}
              className="rounded-xl border border-primary/30 bg-primary/5 px-2 py-0.5 text-xs font-medium text-primary hover:bg-primary/10"
              title={`Show all ${access.allow.length} allowed entries`}
              aria-haspopup="dialog"
            >
              +{hiddenCount} more
            </button>
          )}
          <button
            onClick={openPicker}
            className="flex items-center gap-0.5 rounded-xl border border-dashed border-black/10 px-2 py-0.5 text-xs font-medium text-primary hover:border-primary/50 dark:border-white/10"
          >
            <span className="material-symbols-outlined leading-none" style={{ fontSize: "14px" }}>add</span>
            Add combo or model
          </button>
          {atLimit && (
            <span className="text-xs text-orange-500">Limit of {KEY_ACCESS_MAX_ENTRIES} entries reached.</span>
          )}
        </div>
      )}

      <Modal
        isOpen={listOpen}
        onClose={() => setListOpen(false)}
        title={`Allowed for "${apiKey.name}"`}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setListOpen(false)}>Close</Button>
            <Button
              icon="add"
              onClick={() => {
                setListOpen(false);
                openPicker();
              }}
            >
              Add combo or model
            </Button>
          </>
        }
      >
        <div className="space-y-1.5">
          {access.allow.length === 0 && (
            <p className="text-xs text-orange-500">No combos or models allowed — this key can call nothing.</p>
          )}
          {access.allow.map((entry) => (
            <div key={entry} className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle px-3 py-1.5">
              <span className="min-w-0 truncate font-mono text-xs text-text-main" title={entry}>{entry}</span>
              <button
                onClick={() => remove(entry)}
                className="shrink-0 rounded p-1 text-text-muted hover:text-red-500"
                title={`Remove ${entry}`}
                aria-label={`Remove ${entry}`}
              >
                <span className="material-symbols-outlined leading-none" style={{ fontSize: "16px" }}>close</span>
              </button>
            </div>
          ))}
        </div>
      </Modal>

      {pickerOpen && (
        <ModelSelectModal
          isOpen={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onSelect={(model) => addMany([model])}
          onSelectBatch={addMany}
          onDeselect={(model) => removeMany([model])}
          onDeselectBatch={removeMany}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          title={`Allowed for "${apiKey.name}"`}
          addedModelValues={access.allow}
          closeOnSelect={false}
        />
      )}
    </div>
  );
}

KeyAccessControls.propTypes = {
  apiKey: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string,
    access: PropTypes.shape({ restricted: PropTypes.bool, allow: PropTypes.arrayOf(PropTypes.string) }),
  }).isRequired,
  onChange: PropTypes.func.isRequired,
  onRequestRestrict: PropTypes.func.isRequired,
};
