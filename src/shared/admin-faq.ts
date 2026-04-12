export type FaqSource = "remote" | "local" | "missing";

export type AdminFaqPayload = {
  markdown: string | null;
  source: FaqSource;
  warning: string | null;
};
