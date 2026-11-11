"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Button, Modal, Select, Toggle } from "@/shared/components";
import { CAPACITY_META, STT_TRANSPORT_META, STT_TRANSPORTS } from "@/shared/constants/models";

// Capability editor for a model that already exists on the provider page.
// Mirrors AddCustomModelModal's toggles so an operator can correct a model
// without deleting and re-adding it (and losing its alias/caps history).
export default function EditModelCapsModal({ isOpen, record, fallbackCaps, providerDisplayAlias, onSave, onClose }) {
  const [caps, setCaps] = useState({});
  const [stt, setStt] = useState(false);
  const [transport, setTransport] = useState("");
  const [saving, setSaving] = useState(false);

  // The parent passes record/fallbackCaps as fresh objects on every render, so
  // object identity is not a usable dependency: an unrelated test/status update
  // would re-seed and silently discard the toggle the operator just flipped.
  // Seed on content instead.
  const seedKey = JSON.stringify({
    id: record?.id || null,
    stored: record?.caps || null,
    resolved: fallbackCaps || null,
    type: record?.kind || record?.type || null,
    transport: record?.transport || null,
  });

  useEffect(() => {
    if (!isOpen) return;
    // A model edited for the first time shows what routing currently believes,
    // so saving without changes cannot silently disable a capability.
    setCaps({ ...(fallbackCaps || {}), ...(record?.caps || {}) });
    setStt((record?.kind || record?.type) === "stt");
    setTransport(record?.transport || "");
    setSaving(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, seedKey]);

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSave({
        type: stt ? "stt" : "llm",
        previousType: record?.kind || record?.type || "llm",
        caps,
        transport: stt ? transport : "",
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Edit Capabilities">
      <div className="flex flex-col gap-4">
        <div>
          <label className="text-sm font-medium mb-1.5 block">Model</label>
          <code className="text-xs text-text-muted font-mono bg-sidebar px-1.5 py-0.5 rounded">
            {providerDisplayAlias}/{record?.id}
          </code>
        </div>

        <div>
          <label className="text-sm font-medium mb-1.5 block">Capabilities</label>
          <div className="flex flex-wrap gap-4">
            {Object.entries(CAPACITY_META).map(([key, meta]) => (
              <Toggle
                key={key}
                checked={!!caps[key]}
                onChange={(v) => setCaps((prev) => ({ ...prev, [key]: v }))}
                label={meta.label}
                description={meta.desc}
                size="sm"
              />
            ))}
          </div>
        </div>

        {/* STT is a model TYPE, not a chat capability: saving with this on
            rewrites the record under type "stt" (and back to "llm" when off). */}
        <div>
          <Toggle
            checked={stt}
            onChange={(v) => { setStt(v); if (!v) setTransport(""); }}
            label="Speech to text"
            description="Transcribes audio via /v1/audio/transcriptions"
            size="sm"
          />
          {stt && (
            <div className="mt-3">
              <Select
                label="Transport"
                value={transport}
                onChange={(e) => setTransport(e.target.value)}
                placeholder="Provider default (REST)"
                options={STT_TRANSPORTS.map((t) => ({ value: t, label: STT_TRANSPORT_META[t].label }))}
                hint="Realtime transport marker for the STT dispatcher. Empty keeps the provider's REST format."
              />
            </div>
          )}
        </div>

        <div className="flex gap-2">
          <Button onClick={handleSave} fullWidth loading={saving} disabled={saving}>Save</Button>
          <Button onClick={onClose} variant="ghost" fullWidth>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}

EditModelCapsModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  record: PropTypes.shape({
    id: PropTypes.string,
    caps: PropTypes.object,
    transport: PropTypes.string,
    type: PropTypes.string,
    kind: PropTypes.string,
  }),
  providerDisplayAlias: PropTypes.string.isRequired,
  fallbackCaps: PropTypes.object,
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};

EditModelCapsModal.defaultProps = {
  record: null,
  fallbackCaps: null,
};
