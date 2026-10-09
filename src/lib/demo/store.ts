import { nanoid } from "nanoid";
import type {
  Approval,
  AdspirerServiceAccount,
  Client,
  ClientAccessRequest,
  ClientService,
  Competitor,
  CompetitorAd,
  CompetitorBrief,
  ConnectedMetaAccount,
  Conversation,
  Message,
  MonitoringSnapshot,
  Notification,
  OAuthPkceState,
  Profile,
  Recommendation,
  Task,
  ToolCall,
  UserClientAccess,
  WorkspaceDocument,
} from "@/types";
import { encryptToken } from "@/lib/security/token-vault";
import { addDaysIso, addHoursIso, nowIso } from "@/lib/utils";

export interface DemoStore {
  profiles: Profile[];
  clients: Client[];
  userClientAccess: UserClientAccess[];
  tasks: Task[];
  conversations: Conversation[];
  messages: Message[];
  toolCalls: ToolCall[];
  approvals: Approval[];
  adspirerServiceAccounts: AdspirerServiceAccount[];
  connectedMetaAccounts: ConnectedMetaAccount[];
  clientAccessRequests: ClientAccessRequest[];
  competitorBriefs: CompetitorBrief[];
  clientServices: ClientService[];
  competitors: Competitor[];
  competitorAds: CompetitorAd[];
  monitoringSnapshots: MonitoringSnapshot[];
  recommendations: Recommendation[];
  notifications: Notification[];
  oauthPkceStates: OAuthPkceState[];
  workspaceDocuments: WorkspaceDocument[];
  creativeDrafts?: import("@/lib/creatives/drafts").CreativeDraft[];
}

type GlobalDemo = typeof globalThis & {
  __adspirerDemoStore?: DemoStore;
  __adspirerDemoStoreVersion?: number;
};

const DEMO_STORE_VERSION = 4;

function id(prefix: string): string {
  return `${prefix}_${nanoid(10)}`;
}

function seedStore(): DemoStore {
  const ts = nowIso();

  const adminId = "profile_admin_demo";
  const operatorId = "profile_operator_demo";

  const profiles: Profile[] = [
    {
      id: adminId,
      email: "admin@spendsmith.demo",
      full_name: "Spendsmith Admin",
      role: "admin",
      avatar_url: null,
      is_active: true,
      created_at: ts,
      updated_at: ts,
    },
    {
      id: operatorId,
      email: "operator@spendsmith.demo",
      full_name: "Spendsmith Operator",
      role: "operator",
      avatar_url: null,
      is_active: true,
      created_at: ts,
      updated_at: ts,
    },
  ];

  const trafficRadiusId = "client_trafficradius";
  const clickTrendsId = "client_clicktrends";
  const modernDentalId = "client_modern_dental";

  const clients: Client[] = [
    {
      id: trafficRadiusId,
      name: "TrafficRadius",
      slug: "trafficradius",
      website_url: "https://trafficradius.example",
      industry: "Digital Marketing Agency",
      brand_voice: "Confident, data-driven, partnership-oriented",
      brand_colors: ["#0B3D91", "#F4A261"],
      brand_guidelines: "Lead with outcomes and local market expertise. DEMO DATA.",
      target_audience: "Multi-location SMB brands seeking paid media growth",
      value_proposition: "Full-funnel Meta Ads management with transparent reporting",
      budget_ceiling_cents: 1_000_000,
      currency: "USD",
      notes: "DEMO DATA — agency partner account",
      is_demo: true,
      created_by: adminId,
      created_at: ts,
      updated_at: ts,
    },
    {
      id: clickTrendsId,
      name: "ClickTrends",
      slug: "clicktrends",
      website_url: "https://clicktrends.example",
      industry: "Performance Marketing",
      brand_voice: "Sharp, experimental, ROI-obsessed",
      brand_colors: ["#111827", "#22C55E"],
      brand_guidelines: "Highlight testing velocity and attribution clarity. DEMO DATA.",
      target_audience: "eCommerce brands scaling paid social",
      value_proposition: "Rapid creative testing + efficient Meta spend",
      budget_ceiling_cents: 750_000,
      currency: "USD",
      notes: "DEMO DATA",
      is_demo: true,
      created_by: adminId,
      created_at: ts,
      updated_at: ts,
    },
    {
      id: modernDentalId,
      name: "Modern Dental Centre",
      slug: "modern-dental-centre",
      website_url: "https://moderndental.example",
      industry: "Healthcare — Dental",
      brand_voice: "Warm, trustworthy, modern clinical care",
      brand_colors: ["#1B6CA8", "#E8F4FC", "#F8FAFC"],
      brand_guidelines:
        "Patient-first language. Emphasize comfort, technology, and local care. DEMO DATA.",
      target_audience: "Families and professionals seeking cosmetic & general dentistry",
      value_proposition: "Advanced dental care with a calm, modern patient experience",
      budget_ceiling_cents: 250_000,
      currency: "USD",
      notes: "DEMO DATA — primary demo client for agent audit flow",
      is_demo: true,
      created_by: adminId,
      created_at: ts,
      updated_at: ts,
    },
  ];

  const userClientAccess: UserClientAccess[] = [
    ...clients.map((c) => ({
      id: id("uca"),
      user_id: adminId,
      client_id: c.id,
      granted_by: adminId,
      created_at: ts,
    })),
    ...clients.map((c) => ({
      id: id("uca"),
      user_id: operatorId,
      client_id: c.id,
      granted_by: adminId,
      created_at: ts,
    })),
  ];

  const metaAccounts: ConnectedMetaAccount[] = [
    {
      id: "meta_acc_mdc_1",
      client_id: modernDentalId,
      meta_account_id: "act_100200300",
      meta_account_name: "Modern Dental Centre — Main",
      currency: "USD",
      timezone: "America/New_York",
      business_id: "bm_9001",
      access_status: "granted",
      access_method: "business_manager_partner",
      last_synced_at: ts,
      raw: { demo: true },
      created_at: ts,
      updated_at: ts,
    },
    {
      id: "meta_acc_tr_1",
      client_id: trafficRadiusId,
      meta_account_id: "act_400500600",
      meta_account_name: "TrafficRadius Agency Ad Account",
      currency: "USD",
      timezone: "America/Chicago",
      business_id: "bm_9002",
      access_status: "granted",
      access_method: "direct_grant",
      last_synced_at: ts,
      raw: { demo: true },
      created_at: ts,
      updated_at: ts,
    },
    {
      id: "meta_acc_ct_1",
      client_id: clickTrendsId,
      meta_account_id: "act_700800900",
      meta_account_name: "ClickTrends Performance",
      currency: "USD",
      timezone: "America/Los_Angeles",
      business_id: "bm_9003",
      access_status: "requested",
      access_method: "business_manager_partner",
      last_synced_at: null,
      raw: { demo: true },
      created_at: ts,
      updated_at: ts,
    },
  ];

  const conversationId = "conv_mdc_audit_1";
  const taskId = "task_mdc_audit_1";
  const approvalId = "approval_mdc_budget_1";
  const toolCallId = "toolcall_mdc_budget_1";

  const tasks: Task[] = [
    {
      id: taskId,
      client_id: modernDentalId,
      conversation_id: conversationId,
      created_by: operatorId,
      title: "Audit Modern Dental Meta account",
      goal: "Review campaign health and propose a safe budget increase for New Patient Leads",
      status: "waiting_approval",
      agent_state: {
        phase: "awaiting_approval",
        last_tool: "update_adset_budget",
        findings: ["CPA rising on New Patient Leads ad set", "Frequency healthy"],
      },
      error_message: null,
      paused_at: null,
      completed_at: null,
      created_at: ts,
      updated_at: ts,
    },
    {
      id: "task_tr_overview_1",
      client_id: trafficRadiusId,
      conversation_id: null,
      created_by: adminId,
      title: "Weekly account overview",
      goal: "Summarize spend and delivery",
      status: "done",
      agent_state: { phase: "completed" },
      error_message: null,
      paused_at: null,
      completed_at: ts,
      created_at: ts,
      updated_at: ts,
    },
  ];

  const conversations: Conversation[] = [
    {
      id: conversationId,
      client_id: modernDentalId,
      task_id: taskId,
      created_by: operatorId,
      title: "MDC account audit",
      created_at: ts,
      updated_at: ts,
    },
  ];

  const messages: Message[] = [
    {
      id: id("msg"),
      conversation_id: conversationId,
      role: "user",
      content: "Please audit the Modern Dental Centre Meta account and suggest optimizations.",
      tool_call_id: null,
      metadata: null,
      created_at: ts,
    },
    {
      id: id("msg"),
      conversation_id: conversationId,
      role: "assistant",
      content:
        "I reviewed the account. New Patient Leads is delivery-constrained. I propose raising the ad set daily budget from $40 to $55 (within ceiling). Awaiting your approval.",
      tool_call_id: null,
      metadata: null,
      created_at: ts,
    },
  ];

  const approvals: Approval[] = [
    {
      id: approvalId,
      client_id: modernDentalId,
      task_id: taskId,
      tool_call_id: toolCallId,
      tool_name: "update_adset_budget",
      proposed_args: {
        account_id: "act_100200300",
        adset_id: "adset_mdc_npl_1",
        daily_budget_cents: 5500,
        previous_daily_budget_cents: 4000,
      },
      edited_args: null,
      status: "pending",
      rationale:
        "Increase New Patient Leads daily budget to improve delivery while staying under client ceiling.",
      budget_impact_cents: 1500,
      idempotency_key: `idem_${approvalId}`,
      requested_by: operatorId,
      reviewed_by: null,
      reviewed_at: null,
      expires_at: addHoursIso(72),
      execution_result: null,
      execution_error: null,
      executed_at: null,
      created_at: ts,
      updated_at: ts,
    },
  ];

  const toolCalls: ToolCall[] = [
    {
      id: toolCallId,
      task_id: taskId,
      conversation_id: conversationId,
      tool_name: "update_adset_budget",
      safety_class: "execute",
      arguments: approvals[0].proposed_args,
      result: null,
      error_message: null,
      approval_id: approvalId,
      started_at: ts,
      completed_at: null,
    },
  ];

  const clientServices: ClientService[] = [
    {
      id: "svc_mdc_implants",
      client_id: modernDentalId,
      name: "Dental Implants",
      description: "Single-tooth and full-arch implant solutions",
      keywords: ["dental implants", "tooth replacement", "implant dentist"],
      landing_page_url: "https://moderndental.example/implants",
      is_active: true,
      created_at: ts,
      updated_at: ts,
    },
    {
      id: "svc_mdc_veneers",
      client_id: modernDentalId,
      name: "Veneers",
      description: "Porcelain veneers and smile makeovers",
      keywords: ["veneers", "porcelain veneers", "smile makeover"],
      landing_page_url: "https://moderndental.example/veneers",
      is_active: true,
      created_at: ts,
      updated_at: ts,
    },
  ];

  const competitors: Competitor[] = [
    {
      id: "comp_smile_works",
      client_id: modernDentalId,
      name: "SmileWorks Dental",
      website_url: "https://smileworks.example",
      domain: "smileworks.example",
      notes: "DEMO DATA — local competitor",
      created_at: ts,
      updated_at: ts,
    },
    {
      id: "comp_bright_bite",
      client_id: modernDentalId,
      name: "BrightBite Orthodontics",
      website_url: "https://brightbite.example",
      domain: "brightbite.example",
      notes: "DEMO DATA",
      created_at: ts,
      updated_at: ts,
    },
  ];

  const competitorAds: CompetitorAd[] = [
    {
      id: id("cad"),
      competitor_id: "comp_smile_works",
      client_id: modernDentalId,
      platform: "meta",
      ad_library_id: "lib_sw_001",
      headline: "Same-Week New Patient Appointments",
      body: "Book a comfortable cleaning this week. New patients welcome.",
      cta: "Book Now",
      media_type: "image",
      media_url: null,
      landing_url: "https://smileworks.example/book",
      first_seen_at: ts,
      last_seen_at: ts,
      raw: { demo: true },
      created_at: ts,
    },
  ];

  const competitorBriefs: CompetitorBrief[] = [
    {
      id: "brief_mdc_cosmetic_1",
      client_id: modernDentalId,
      client_service_id: "svc_mdc_implants",
      status: "ready",
      summary:
        "Local competitors emphasize speed-to-appointment and financing. Opportunity to differentiate on technology and calm patient experience. DEMO DATA.",
      strengths: ["Warm clinical tone", "Strong local trust signals"],
      weaknesses: ["Fewer urgency CTAs than SmileWorks"],
      messaging_themes: ["Comfort", "Modern tech", "Family care"],
      creative_patterns: ["Before/after smiles", "Team portraits", "Office walkthrough"],
      opportunities: [
        "Lead with same-week cosmetic consult availability",
        "Test financing mention in primary text",
      ],
      raw_research: { source: "mock", demo: true },
      generated_at: ts,
      created_at: ts,
      updated_at: ts,
    },
  ];

  const monitoringSnapshots: MonitoringSnapshot[] = [
    {
      id: "snap_mdc_1",
      client_id: modernDentalId,
      meta_account_id: "act_100200300",
      period_start: addDaysIso(-7),
      period_end: ts,
      metrics: {
        spend: 612.4,
        impressions: 48_200,
        clicks: 1_140,
        ctr: 2.36,
        cpc: 0.54,
        leads: 38,
        cpl: 16.12,
        frequency: 1.8,
        reach: 26_700,
      },
      findings: [
        {
          code: "CPL_UP",
          severity: "warning",
          title: "CPL above 14-day baseline",
          detail: "Cost per lead rose 18% week-over-week on New Patient Leads.",
          metric_key: "cpl",
          metric_value: 16.12,
          baseline_value: 13.65,
        },
      ],
      created_at: ts,
    },
    {
      id: "snap_mdc_0",
      client_id: modernDentalId,
      meta_account_id: "act_100200300",
      period_start: addDaysIso(-14),
      period_end: addDaysIso(-7),
      metrics: {
        spend: 540.1,
        impressions: 44_100,
        clicks: 1_050,
        ctr: 2.38,
        cpc: 0.51,
        leads: 42,
        cpl: 12.86,
        frequency: 1.7,
        reach: 25_900,
      },
      findings: [],
      created_at: addDaysIso(-7),
    },
  ];

  const recommendations: Recommendation[] = [
    {
      id: id("rec"),
      client_id: modernDentalId,
      task_id: taskId,
      title: "Increase New Patient Leads budget",
      description: "Raise daily budget $40 → $55 to relieve delivery constraints.",
      category: "budget",
      status: "open",
      proposed_tool: "update_adset_budget",
      proposed_args: approvals[0].proposed_args,
      created_by: operatorId,
      created_at: ts,
      updated_at: ts,
    },
  ];

  const notifications: Notification[] = [
    {
      id: id("notif"),
      user_id: adminId,
      client_id: modernDentalId,
      type: "approval_pending",
      title: "Approval needed: update_adset_budget",
      body: "Modern Dental Centre — raise New Patient Leads daily budget to $55.",
      href: `/clients/${modernDentalId}/approvals/${approvalId}`,
      read_at: null,
      created_at: ts,
    },
  ];

  let encryptedAccess: string;
  let encryptedRefresh: string;
  try {
    encryptedAccess = encryptToken("demo_adspirer_access_token");
    encryptedRefresh = encryptToken("demo_adspirer_refresh_token");
  } catch {
    // Vault may be unavailable during early module init; use opaque placeholders.
    encryptedAccess = "v1:demo:placeholder:access";
    encryptedRefresh = "v1:demo:placeholder:refresh";
  }

  const adspirerServiceAccounts: AdspirerServiceAccount[] = [
    {
      id: "asa_shared_1",
      label: "Adspirer Shared Service Account (DEMO)",
      encrypted_access_token: encryptedAccess,
      encrypted_refresh_token: encryptedRefresh,
      token_expires_at: addDaysIso(30),
      scopes: ["ads_read", "ads_management"],
      is_active: true,
      last_refreshed_at: ts,
      created_at: ts,
      updated_at: ts,
    },
  ];

  const clientAccessRequests: ClientAccessRequest[] = [
    {
      id: id("car"),
      client_id: clickTrendsId,
      connected_meta_account_id: "meta_acc_ct_1",
      access_method: "business_manager_partner",
      status: "requested",
      instructions: "Invite the Spendsmith BM as partner with Ads management.",
      recipient_email: "ads@clicktrends.example",
      sent_at: ts,
      sent_manually: true,
      marked_stale_at: null,
      granted_at: null,
      created_by: operatorId,
      created_at: ts,
      updated_at: ts,
    },
  ];

  return {
    profiles,
    clients,
    userClientAccess,
    tasks,
    conversations,
    messages,
    toolCalls,
    approvals,
    adspirerServiceAccounts,
    connectedMetaAccounts: metaAccounts,
    clientAccessRequests,
    competitorBriefs,
    clientServices,
    competitors,
    competitorAds,
    monitoringSnapshots,
    recommendations,
    notifications,
    oauthPkceStates: [],
    workspaceDocuments: [],
  };
}

/**
 * Singleton demo store — survives Next.js hot reloads via globalThis.
 */
export function getDemoStore(): DemoStore {
  const g = globalThis as GlobalDemo;
  if (!g.__adspirerDemoStore || g.__adspirerDemoStoreVersion !== DEMO_STORE_VERSION) {
    g.__adspirerDemoStore = seedStore();
    g.__adspirerDemoStoreVersion = DEMO_STORE_VERSION;
  }
  return g.__adspirerDemoStore;
}

export function resetDemoStore(): DemoStore {
  const g = globalThis as GlobalDemo;
  g.__adspirerDemoStore = seedStore();
  return g.__adspirerDemoStore;
}

export function demoNow(): string {
  return nowIso();
}
