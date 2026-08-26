import { ExternalLink } from "lucide-react";
import { translateAppString } from "../lib/app-language";
import type { StringKey } from "../i18n/catalog";

const t = translateAppString;

interface ServiceQuickLink {
  readonly label: string;
  readonly href: string;
}

const SERVICE_QUICK_LINKS: Record<string, ReadonlyArray<{ labelKey: StringKey; href: string }>> = {
  kimicode: [
    { labelKey: "workflow.serviceLinks.website", href: "https://www.kimi.com?aff=inkos" },
  ],
  kimiCodingPlan: [
    { labelKey: "workflow.serviceLinks.website", href: "https://www.kimi.com?aff=inkos" },
  ],
  kkaiapi: [
    { labelKey: "workflow.serviceLinks.website", href: "https://kkaiapi.com/" },
    { labelKey: "workflow.serviceLinks.apiDocs", href: "https://kkaiapi.com/docs" },
    { labelKey: "workflow.serviceLinks.modelsPricing", href: "https://kkaiapi.com/models" },
  ],
  moonshot: [
    { labelKey: "workflow.serviceLinks.developerPlatform", href: "https://platform.kimi.com?aff=inkos" },
  ],
  openrouter: [
    { labelKey: "workflow.serviceLinks.apiKeys", href: "https://openrouter.ai/keys" },
    { labelKey: "workflow.serviceLinks.models", href: "https://openrouter.ai/models" },
    { labelKey: "workflow.serviceLinks.docs", href: "https://openrouter.ai/docs/api-reference/overview" },
  ],
};

export function getServiceQuickLinks(serviceId: string): ReadonlyArray<ServiceQuickLink> {
  return (SERVICE_QUICK_LINKS[serviceId] ?? []).map((link) => ({
    label: t(link.labelKey),
    href: link.href,
  }));
}

export function ServiceQuickLinks({
  serviceId,
  variant = "detail",
  className = "",
}: {
  readonly serviceId: string;
  readonly variant?: "card" | "detail";
  readonly className?: string;
}) {
  const links = getServiceQuickLinks(serviceId);
  if (links.length === 0) return null;

  const compact = variant === "card";
  return (
    <div
      className={[
        "flex flex-wrap items-center gap-1.5 text-muted-foreground/70",
        compact ? "text-[11px]" : "text-xs",
        className,
      ].filter(Boolean).join(" ")}
    >
      {!compact && <span className="mr-0.5">{t("workflow.serviceLinks.title")}</span>}
      {links.map((link) => (
        <a
          key={link.href}
          href={link.href}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => event.stopPropagation()}
          className={[
            "inline-flex items-center gap-1 rounded-md border border-border/40 bg-card/50 font-medium text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground",
            compact ? "px-1.5 py-0.5" : "px-2 py-1",
          ].join(" ")}
        >
          {link.label}
          <ExternalLink size={compact ? 10 : 11} />
        </a>
      ))}
    </div>
  );
}
