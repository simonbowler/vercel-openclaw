"use client";

import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { ReadJsonDeps } from "@/components/admin-request-core";
import { fetchAdminJsonCore } from "@/components/admin-request-core";
import type { AdminFaqPayload } from "@/shared/admin-faq";

type FaqPanelProps = {
  active: boolean;
  readDeps: ReadJsonDeps;
};

export function FaqPanel({ active, readDeps }: FaqPanelProps) {
  const [faq, setFaq] = useState<AdminFaqPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);

  const fetchFaq = useCallback(async () => {
    if (!active) {
      return;
    }

    setLoading(true);
    try {
      const result = await fetchAdminJsonCore<AdminFaqPayload>(
        "/api/admin/faq",
        readDeps,
        { toastError: false },
      );

      if (result.ok) {
        setFaq(result.data);
        setReadError(null);
        return;
      }

      setReadError(result.error);
    } finally {
      setLoading(false);
    }
  }, [active, readDeps]);

  useEffect(() => {
    if (!active) {
      return;
    }

    void fetchFaq();
  }, [active, fetchFaq]);

  return (
    <article className="panel-card">
      <div className="panel-head">
        <div>
          <h2>Frequently asked questions</h2>
          <p className="muted-copy faq-panel-intro">
            Live content is loaded from GitHub when this tab opens, then falls back to the local
            repository copy if GitHub is unavailable.
          </p>
        </div>
        <button
          type="button"
          className="button ghost"
          onClick={() => void fetchFaq()}
          disabled={loading}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {readError && (
        <p className="error-banner">
          Failed to load the FAQ: {readError}
        </p>
      )}

      {!readError && faq?.warning && faq.warning !== "FAQ unavailable." && (
        <p className="faq-banner">{faq.warning}</p>
      )}

      {loading && !faq && (
        <p className="empty-token">Loading FAQ…</p>
      )}

      {!loading && !readError && faq?.source === "missing" && (
        <p className="empty-token">Add a root `FAQ.md` to provide a bundled fallback.</p>
      )}

      {!readError && faq?.markdown && (
        <div className="faq-content">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ node: _node, ...props }) => (
                <a
                  {...props}
                  target="_blank"
                  rel="noreferrer"
                />
              ),
            }}
          >
            {faq.markdown}
          </ReactMarkdown>
        </div>
      )}
    </article>
  );
}
