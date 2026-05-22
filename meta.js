// ============================================================
// MACARON DE LUXE · Meta Graph API Client (read-only, Stage 2)
// --------------------------------------------------------------
// Wraps Graph API v21.0 endpoints for:
//   • Facebook Page posts / insights
//   • Instagram Business media / insights
//   • Meta Ads account-level insights + campaign list
//
// All calls are READ-ONLY. Writes (publishing, ad-budget edits)
// come in Stage 3.
//
// Required env vars:
//   META_ACCESS_TOKEN     long-lived system-user or page token
//   META_FB_PAGE_ID       numeric FB page id (optional)
//   META_IG_USER_ID       numeric IG Business user id (optional)
//   META_AD_ACCOUNT_ID    numeric ad account id without act_ prefix (optional)
// =============================================================

const GRAPH = "https://graph.facebook.com/v21.0";

function tokenOk() {
  return !!process.env.META_ACCESS_TOKEN;
}

async function graphGet(pathWithQuery) {
  if (!tokenOk()) throw new Error("META_ACCESS_TOKEN not set");
  const sep = pathWithQuery.includes("?") ? "&" : "?";
  const url = `${GRAPH}${pathWithQuery}${sep}access_token=${encodeURIComponent(process.env.META_ACCESS_TOKEN)}`;
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const msg = body.error?.message || `HTTP ${res.status}`;
    const code = body.error?.code;
    const err = new Error(`Graph API error: ${msg}${code ? ` (code ${code})` : ""}`);
    err.status = res.status;
    err.graphError = body.error;
    throw err;
  }
  return body;
}

// ─────────────────────── health / status ───────────────────────

async function getStatus() {
  const out = {
    tokenSet: tokenOk(),
    pageIdSet: !!process.env.META_FB_PAGE_ID,
    igIdSet: !!process.env.META_IG_USER_ID,
    adAccountSet: !!process.env.META_AD_ACCOUNT_ID,
    me: null,
    page: null,
    ig: null,
    ad: null,
    errors: [],
  };
  if (!out.tokenSet) {
    out.errors.push("META_ACCESS_TOKEN missing");
    return out;
  }
  try {
    out.me = await graphGet(`/me?fields=id,name`);
  } catch (e) {
    out.errors.push("token check: " + e.message);
  }
  if (out.pageIdSet) {
    try {
      out.page = await graphGet(`/${process.env.META_FB_PAGE_ID}?fields=id,name,fan_count,followers_count,about`);
    } catch (e) {
      out.errors.push("FB page: " + e.message);
    }
  }
  if (out.igIdSet) {
    try {
      out.ig = await graphGet(`/${process.env.META_IG_USER_ID}?fields=id,username,followers_count,media_count`);
    } catch (e) {
      out.errors.push("IG: " + e.message);
    }
  }
  if (out.adAccountSet) {
    try {
      out.ad = await graphGet(`/act_${process.env.META_AD_ACCOUNT_ID}?fields=name,account_status,currency,amount_spent,balance`);
    } catch (e) {
      out.errors.push("Ads: " + e.message);
    }
  }
  return out;
}

// ─────────────────────── Facebook Page ───────────────────────

async function getFbPagePosts({ limit = 10 } = {}) {
  const id = process.env.META_FB_PAGE_ID;
  if (!id) throw new Error("META_FB_PAGE_ID not set");
  const fields = [
    "id",
    "message",
    "created_time",
    "permalink_url",
    "reactions.summary(total_count)",
    "comments.summary(total_count)",
    "shares",
  ].join(",");
  const data = await graphGet(`/${id}/posts?fields=${fields}&limit=${limit}`);
  return (data.data || []).map(p => ({
    id: p.id,
    message: p.message || "",
    createdTime: p.created_time,
    permalink: p.permalink_url,
    reactions: p.reactions?.summary?.total_count ?? 0,
    comments: p.comments?.summary?.total_count ?? 0,
    shares: p.shares?.count ?? 0,
  }));
}

// ─────────────────────── Instagram Business ───────────────────────

async function getIgMedia({ limit = 10 } = {}) {
  const id = process.env.META_IG_USER_ID;
  if (!id) throw new Error("META_IG_USER_ID not set");
  const fields = [
    "id",
    "caption",
    "media_type",
    "media_url",
    "thumbnail_url",
    "permalink",
    "timestamp",
    "like_count",
    "comments_count",
  ].join(",");
  const data = await graphGet(`/${id}/media?fields=${fields}&limit=${limit}`);
  return (data.data || []).map(m => ({
    id: m.id,
    caption: m.caption || "",
    mediaType: m.media_type,
    mediaUrl: m.media_url,
    thumbnail: m.thumbnail_url,
    permalink: m.permalink,
    timestamp: m.timestamp,
    likes: m.like_count ?? 0,
    comments: m.comments_count ?? 0,
  }));
}

// ─────────────────────── Meta Ads ───────────────────────

async function getAdsInsights({ datePreset = "last_7d" } = {}) {
  const id = process.env.META_AD_ACCOUNT_ID;
  if (!id) throw new Error("META_AD_ACCOUNT_ID not set");
  const fields = [
    "impressions",
    "reach",
    "clicks",
    "ctr",
    "cpc",
    "cpm",
    "spend",
    "actions",
    "action_values",
    "date_start",
    "date_stop",
  ].join(",");
  const data = await graphGet(`/act_${id}/insights?fields=${fields}&date_preset=${datePreset}&level=account`);
  const row = (data.data || [])[0] || null;
  if (!row) return null;
  const purchases = (row.actions || []).find(a => a.action_type === "purchase");
  const purchaseValue = (row.action_values || []).find(a => a.action_type === "purchase");
  return {
    dateStart: row.date_start,
    dateStop: row.date_stop,
    impressions: Number(row.impressions || 0),
    reach: Number(row.reach || 0),
    clicks: Number(row.clicks || 0),
    ctr: Number(row.ctr || 0),
    cpc: Number(row.cpc || 0),
    cpm: Number(row.cpm || 0),
    spend: Number(row.spend || 0),
    purchases: Number(purchases?.value || 0),
    revenue: Number(purchaseValue?.value || 0),
    roas: purchaseValue && row.spend ? Number(purchaseValue.value) / Number(row.spend) : null,
  };
}

async function getAdCampaigns({ limit = 25 } = {}) {
  const id = process.env.META_AD_ACCOUNT_ID;
  if (!id) throw new Error("META_AD_ACCOUNT_ID not set");
  const fields = [
    "id",
    "name",
    "status",
    "effective_status",
    "objective",
    "daily_budget",
    "lifetime_budget",
    "start_time",
    "stop_time",
  ].join(",");
  const data = await graphGet(`/act_${id}/campaigns?fields=${fields}&limit=${limit}`);
  return (data.data || []).map(c => ({
    id: c.id,
    name: c.name,
    status: c.status,
    effectiveStatus: c.effective_status,
    objective: c.objective,
    dailyBudget: c.daily_budget ? Number(c.daily_budget) / 100 : null,
    lifetimeBudget: c.lifetime_budget ? Number(c.lifetime_budget) / 100 : null,
    startTime: c.start_time,
    stopTime: c.stop_time,
  }));
}

// ─────────────────────── Live-data snapshot for prompt injection ───────────────────────

// Returns a compact plain-text block suitable for stuffing into an
// employee system prompt so LEON / NOVA / ZARA have real numbers.
async function buildLiveDataBlock({ include = ["fb", "ig", "ads"] } = {}) {
  if (!tokenOk()) return null;
  const chunks = [];
  if (include.includes("fb") && process.env.META_FB_PAGE_ID) {
    try {
      const posts = await getFbPagePosts({ limit: 5 });
      chunks.push(
        `[FB 最新 5 篇貼文]\n` +
          posts
            .map(
              (p, i) =>
                `${i + 1}. (${p.createdTime?.slice(0, 10)}) ❤️${p.reactions} 💬${p.comments} 🔁${p.shares}\n   ${String(p.message).slice(0, 120)}`
            )
            .join("\n")
      );
    } catch (e) {
      chunks.push(`[FB] 讀取失敗：${e.message}`);
    }
  }
  if (include.includes("ig") && process.env.META_IG_USER_ID) {
    try {
      const media = await getIgMedia({ limit: 5 });
      chunks.push(
        `[IG 最新 5 篇]\n` +
          media
            .map(
              (m, i) =>
                `${i + 1}. (${m.timestamp?.slice(0, 10)}) ❤️${m.likes} 💬${m.comments} · ${m.mediaType}\n   ${String(m.caption).slice(0, 120)}`
            )
            .join("\n")
      );
    } catch (e) {
      chunks.push(`[IG] 讀取失敗：${e.message}`);
    }
  }
  if (include.includes("ads") && process.env.META_AD_ACCOUNT_ID) {
    try {
      const ins = await getAdsInsights({ datePreset: "last_7d" });
      if (ins) {
        chunks.push(
          `[Ads 過去 7 天帳戶總覽]\n` +
            `曝光 ${ins.impressions.toLocaleString()} | 觸及 ${ins.reach.toLocaleString()} | 點擊 ${ins.clicks.toLocaleString()}\n` +
            `CTR ${ins.ctr.toFixed(2)}% | CPC $${ins.cpc.toFixed(2)} | CPM $${ins.cpm.toFixed(2)}\n` +
            `花費 $${ins.spend.toFixed(0)} | 購買次數 ${ins.purchases} | 收益 $${ins.revenue.toFixed(0)}` +
            (ins.roas !== null ? ` | ROAS ${ins.roas.toFixed(2)}` : "")
        );
      }
      const camps = await getAdCampaigns({ limit: 10 });
      if (camps.length) {
        chunks.push(
          `[Ads 活動清單 top 10]\n` +
            camps
              .map(
                (c, i) =>
                  `${i + 1}. ${c.name} · ${c.effectiveStatus} · ${c.objective}` +
                  (c.dailyBudget ? ` · 日預算 $${c.dailyBudget}` : "") +
                  (c.lifetimeBudget ? ` · 總預算 $${c.lifetimeBudget}` : "")
              )
              .join("\n")
        );
      }
    } catch (e) {
      chunks.push(`[Ads] 讀取失敗：${e.message}`);
    }
  }
  if (!chunks.length) return null;
  return chunks.join("\n\n");
}

// ─────────────────────── Enhanced coaching data snapshot ───────────────────────

// Returns a richer coaching-focused data block for all 9 employees
// Includes recent posts with engagement, account summaries, and ads performance
async function buildCoachDataBlock() {
  if (!tokenOk()) return null;
  const parts = [];

  // Basic page stats with coaching context
  if (process.env.META_FB_PAGE_ID) {
    try {
      const page = await graphGet(
        `${process.env.META_FB_PAGE_ID}?fields=id,name,fan_count,followers_count,new_fan_count,talking_about_count`
      );
      parts.push(`[FB 粉專概況]`);
      parts.push(`名稱: ${page.name} | 粉絲: ${page.fan_count || 0} | 追蹤: ${page.followers_count || 0}`);
      if (page.talking_about_count) parts.push(`本週互動人數: ${page.talking_about_count}`);

      // Recent posts with engagement data
      try {
        const posts = await getFbPagePosts({ limit: 5 });
        if (posts.length) {
          parts.push(`\n[FB 最近 5 篇貼文表現]`);
          posts.forEach((p, i) => {
            const date = p.createdTime ? p.createdTime.slice(0, 10) : "?";
            parts.push(`${i + 1}. (${date}) ❤️${p.reactions || 0} 💬${p.comments || 0} 🔁${p.shares || 0}`);
            if (p.message) parts.push(`   ${p.message.slice(0, 80)}${p.message.length > 80 ? "…" : ""}`);
          });
        }
      } catch (e) {
        parts.push(`(FB 貼文讀取失敗: ${e.message})`);
      }
    } catch (e) {
      parts.push(`[FB] 讀取失敗：${e.message}`);
    }
  }

  if (process.env.META_IG_USER_ID) {
    try {
      const ig = await graphGet(
        `${process.env.META_IG_USER_ID}?fields=id,username,followers_count,follows_count,media_count`
      );
      parts.push(`\n[IG 帳號概況]`);
      parts.push(`@${ig.username} | 追蹤者: ${ig.followers_count || 0} | 貼文數: ${ig.media_count || 0}`);
      if (ig.follows_count) parts.push(`正在追蹤: ${ig.follows_count}`);

      try {
        const media = await getIgMedia({ limit: 5 });
        if (media.length) {
          parts.push(`\n[IG 最近 5 篇貼文表現]`);
          media.forEach((m, i) => {
            const date = m.timestamp ? m.timestamp.slice(0, 10) : "?";
            const type =
              m.mediaType === "VIDEO" ? "🎬" : m.mediaType === "CAROUSEL_ALBUM" ? "📸多圖" : "📷";
            parts.push(`${i + 1}. ${type} (${date}) ❤️${m.likes || 0} 💬${m.comments || 0}`);
            if (m.caption) parts.push(`   ${m.caption.slice(0, 80)}${m.caption.length > 80 ? "…" : ""}`);
          });
        }
      } catch (e) {
        parts.push(`(IG 貼文讀取失敗: ${e.message})`);
      }
    } catch (e) {
      parts.push(`[IG] 讀取失敗：${e.message}`);
    }
  }

  // Ads insights if available
  if (process.env.META_AD_ACCOUNT_ID) {
    try {
      const insights = await getAdsInsights({ datePreset: "last_7d" });
      if (insights) {
        parts.push(`\n[Meta 廣告 · 過去 7 天帳戶總覽]`);
        parts.push(
          `曝光 ${(insights.impressions || 0).toLocaleString()} | 觸及 ${(insights.reach || 0).toLocaleString()} | 點擊 ${(insights.clicks || 0).toLocaleString()}`
        );
        parts.push(
          `CTR ${(insights.ctr || 0).toFixed(2)}% | CPC NT$${(insights.cpc || 0).toFixed(0)} | CPM NT$${(insights.cpm || 0).toFixed(0)}`
        );
        const spend = insights.spend || 0;
        const revenue = insights.revenue || 0;
        parts.push(
          `花費 NT$${spend.toFixed(0)} | 購買 ${insights.purchases || 0} | 營收 NT$${revenue.toFixed(0)}` +
            (insights.roas !== null ? ` | ROAS ${insights.roas.toFixed(2)}` : "")
        );
      }
    } catch (e) {
      parts.push(`\n[Meta 廣告] 讀取失敗: ${e.message}`);
    }
  } else {
    parts.push(`\n[Meta 廣告] 尚未設定廣告帳號 (META_AD_ACCOUNT_ID)`);
  }

  parts.push(`\n(資料來源：Meta Graph API · 即時)`);
  return parts.length > 2 ? parts.join("\n") : null;
}

// ─────────────────────── WRITE APIs (Stage 3 · Phase 1) ───────────────────────
// These are DANGEROUS endpoints. All server routes that call them must
// require explicit user confirmation before execution.

async function graphPost(pathWithQuery, body = {}) {
  if (!tokenOk()) throw new Error("META_ACCESS_TOKEN not set");
  const url = `${GRAPH}${pathWithQuery}`;
  const params = new URLSearchParams({
    ...body,
    access_token: process.env.META_ACCESS_TOKEN,
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const b = await res.json().catch(() => ({}));
  if (!res.ok || b.error) {
    const msg = b.error?.message || `HTTP ${res.status}`;
    const code = b.error?.code;
    const err = new Error(`Graph API error: ${msg}${code ? ` (code ${code})` : ""}`);
    err.status = res.status;
    err.graphError = b.error;
    throw err;
  }
  return b;
}

// ─────────────────────── Ads list with insights ───────────────────────
// Used by the optimize/propose-pauses endpoint to analyze each ad.
async function getAdsWithInsights({ datePreset = "last_7d", limit = 100 } = {}) {
  const id = process.env.META_AD_ACCOUNT_ID;
  if (!id) throw new Error("META_AD_ACCOUNT_ID not set");
  const fields = [
    "id",
    "name",
    "status",
    "effective_status",
    "adset_id",
    "campaign_id",
    "created_time",
    `insights.date_preset(${datePreset}){impressions,clicks,ctr,cpm,spend,actions,action_values}`,
  ].join(",");
  const data = await graphGet(`/act_${id}/ads?fields=${fields}&limit=${limit}`);
  return (data.data || []).map(ad => {
    const ins = (ad.insights?.data || [])[0] || null;
    const purchases = ins ? (ins.actions || []).find(a => a.action_type === "purchase") : null;
    const revenue = ins ? (ins.action_values || []).find(a => a.action_type === "purchase") : null;
    const spend = ins ? Number(ins.spend || 0) : 0;
    const purchaseValue = revenue ? Number(revenue.value) : 0;
    return {
      id: ad.id,
      name: ad.name,
      status: ad.status,
      effectiveStatus: ad.effective_status,
      adsetId: ad.adset_id,
      campaignId: ad.campaign_id,
      createdTime: ad.created_time,
      ageDays: ad.created_time
        ? Math.floor((Date.now() - new Date(ad.created_time).getTime()) / 86400000)
        : null,
      insights: ins ? {
        impressions: Number(ins.impressions || 0),
        clicks: Number(ins.clicks || 0),
        ctr: Number(ins.ctr || 0),
        cpm: Number(ins.cpm || 0),
        spend,
        purchases: purchases ? Number(purchases.value) : 0,
        revenue: purchaseValue,
        roas: spend > 0 && purchaseValue > 0 ? purchaseValue / spend : null,
      } : null,
    };
  });
}

// ─────────────────────── Status updates (PAUSE / RESUME) ───────────────────────

async function updateEntityStatus(entityId, status) {
  if (!/^(PAUSED|ACTIVE)$/.test(status)) throw new Error("status must be PAUSED or ACTIVE");
  if (!entityId) throw new Error("entityId required");
  return await graphPost(`/${entityId}`, { status });
}

async function pauseAd(adId) { return await updateEntityStatus(adId, "PAUSED"); }
async function resumeAd(adId) { return await updateEntityStatus(adId, "ACTIVE"); }
async function pauseAdSet(adsetId) { return await updateEntityStatus(adsetId, "PAUSED"); }
async function resumeAdSet(adsetId) { return await updateEntityStatus(adsetId, "ACTIVE"); }
async function pauseCampaign(campaignId) { return await updateEntityStatus(campaignId, "PAUSED"); }
async function resumeCampaign(campaignId) { return await updateEntityStatus(campaignId, "ACTIVE"); }

// ─────────────────────── Guardrail logic ───────────────────────
// Analyze ads array and return structured pause proposals with reasons.
// Does NOT execute anything — pure function.
function proposePausesFromAds(ads, rules = {}) {
  const {
    minAgeDays = 3,
    minSpend = 1000,       // NTD
    roasThreshold = 0.8,
    ctrThreshold = 0.5,    // percent
    cpmCeiling = 250,
    maxProposals = 5,
  } = rules;

  const proposals = [];
  for (const ad of ads || []) {
    if (ad.status !== "ACTIVE") continue;
    if (!ad.insights) continue;
    if (ad.ageDays !== null && ad.ageDays < minAgeDays) continue;
    if (ad.insights.spend < minSpend) continue;

    const reasons = [];
    const roas = ad.insights.roas;
    const ctr = ad.insights.ctr;
    const cpm = ad.insights.cpm;

    if (roas !== null && roas < roasThreshold) {
      reasons.push(`ROAS ${roas.toFixed(2)} < ${roasThreshold}（花 NT$${Math.round(ad.insights.spend)} 僅回收 NT$${Math.round(ad.insights.revenue)}）`);
    }
    if (ctr < ctrThreshold && cpm > cpmCeiling) {
      reasons.push(`CTR ${ctr.toFixed(2)}% + CPM NT$${Math.round(cpm)}：素材無吸引力且 Meta 已懲罰`);
    }
    if (ad.insights.spend > minSpend * 2 && ad.insights.purchases === 0) {
      reasons.push(`花 NT$${Math.round(ad.insights.spend)} 但 0 筆轉換（漏斗嚴重失衡）`);
    }

    if (reasons.length > 0) {
      const dailySpend = ad.insights.spend / Math.max(ad.ageDays || 1, 1);
      proposals.push({
        adId: ad.id,
        adName: ad.name,
        campaignId: ad.campaignId,
        adsetId: ad.adsetId,
        ageDays: ad.ageDays,
        spend: ad.insights.spend,
        roas,
        ctr,
        cpm,
        purchases: ad.insights.purchases,
        revenue: ad.insights.revenue,
        reasons,
        action: "PAUSE",
        estimatedMonthlySaving: Math.round(dailySpend * 30),
      });
    }
  }

  // Sort: worst ROAS first, then biggest spender. Take top N.
  proposals.sort((a, b) => {
    const aRoas = a.roas ?? 0;
    const bRoas = b.roas ?? 0;
    if (aRoas !== bRoas) return aRoas - bRoas;
    return b.spend - a.spend;
  });

  return proposals.slice(0, maxProposals);
}


// ─────────────────────── Budget updates (Phase 1 Feature 2) ───────────────────────
// Meta Graph daily_budget 用 "cents" (minor unit)，TWD 其實是整數 NT$
// 但 Meta 仍以 minor unit 儲存（× 100），所以 NT$500 = 50000
// 讀的時候 meta.js 內部已 / 100 還原為 NTD；寫的時候要 × 100 放回去

async function updateAdSetBudget(adsetId, newDailyBudgetNTD) {
  if (!adsetId) throw new Error("adsetId required");
  if (!Number.isFinite(newDailyBudgetNTD) || newDailyBudgetNTD < 100) {
    throw new Error("newDailyBudgetNTD must be >= 100 NTD");
  }
  const minorUnit = Math.round(newDailyBudgetNTD * 100);
  return await graphPost(`/${adsetId}`, { daily_budget: String(minorUnit) });
}

async function updateCampaignBudget(campaignId, newDailyBudgetNTD) {
  if (!campaignId) throw new Error("campaignId required");
  if (!Number.isFinite(newDailyBudgetNTD) || newDailyBudgetNTD < 100) {
    throw new Error("newDailyBudgetNTD must be >= 100 NTD");
  }
  const minorUnit = Math.round(newDailyBudgetNTD * 100);
  return await graphPost(`/${campaignId}`, { daily_budget: String(minorUnit) });
}

// AdSets with insights + current budget — 給 propose-budget-changes 用
async function getAdSetsWithInsights({ datePreset = "last_7d", limit = 100 } = {}) {
  const id = process.env.META_AD_ACCOUNT_ID;
  if (!id) throw new Error("META_AD_ACCOUNT_ID not set");
  const fields = [
    "id",
    "name",
    "status",
    "effective_status",
    "campaign_id",
    "daily_budget",
    "lifetime_budget",
    "created_time",
    `insights.date_preset(${datePreset}){impressions,clicks,ctr,cpm,spend,actions,action_values}`,
  ].join(",");
  const data = await graphGet(`/act_${id}/adsets?fields=${fields}&limit=${limit}`);
  return (data.data || []).map(as => {
    const ins = (as.insights?.data || [])[0] || null;
    const purchases = ins ? (ins.actions || []).find(a => a.action_type === "purchase") : null;
    const revenue = ins ? (ins.action_values || []).find(a => a.action_type === "purchase") : null;
    const spend = ins ? Number(ins.spend || 0) : 0;
    const purchaseValue = revenue ? Number(revenue.value) : 0;
    return {
      id: as.id,
      name: as.name,
      status: as.status,
      effectiveStatus: as.effective_status,
      campaignId: as.campaign_id,
      dailyBudget: as.daily_budget ? Number(as.daily_budget) / 100 : null,
      lifetimeBudget: as.lifetime_budget ? Number(as.lifetime_budget) / 100 : null,
      createdTime: as.created_time,
      ageDays: as.created_time
        ? Math.floor((Date.now() - new Date(as.created_time).getTime()) / 86400000)
        : null,
      insights: ins ? {
        impressions: Number(ins.impressions || 0),
        clicks: Number(ins.clicks || 0),
        ctr: Number(ins.ctr || 0),
        cpm: Number(ins.cpm || 0),
        spend,
        purchases: purchases ? Number(purchases.value) : 0,
        revenue: purchaseValue,
        roas: spend > 0 && purchaseValue > 0 ? purchaseValue / spend : null,
      } : null,
    };
  });
}

// Guardrail: 分析 adsets 給預算調整建議
function proposeBudgetChangesFromAdSets(adsets, rules = {}) {
  const {
    minAgeDays = 3,
    minSpend = 1000,
    roasHighThreshold = 2.5,     // ROAS >= 2.5 加碼
    roasLowThreshold = 1.5,      // ROAS < 1.5 (但 >= 0.8) 減碼
    increasePercent = 20,         // +20%
    decreasePercent = 30,         // -30%
    maxDailyBudget = 500,         // 單 adset 日預算上限 NT$
    minDailyBudget = 100,         // 單 adset 日預算下限 NT$
    maxProposals = 10,
  } = rules;

  const proposals = [];
  for (const a of adsets || []) {
    if (a.status !== "ACTIVE") continue;
    if (!a.insights) continue;
    if (a.dailyBudget === null) continue;    // 只處理有日預算的 adset
    if (a.ageDays !== null && a.ageDays < minAgeDays) continue;
    if (a.insights.spend < minSpend) continue;

    const roas = a.insights.roas;
    if (roas === null) continue;

    let action = null;
    let newBudget = null;
    let reasons = [];

    if (roas >= roasHighThreshold) {
      // 加碼
      const raw = a.dailyBudget * (1 + increasePercent / 100);
      newBudget = Math.min(Math.round(raw / 10) * 10, maxDailyBudget);
      if (newBudget <= a.dailyBudget) continue; // 已達上限
      action = "INCREASE";
      reasons.push(`ROAS ${roas.toFixed(2)} ≥ ${roasHighThreshold}，建議加碼 +${increasePercent}% (NT$${a.dailyBudget} → NT$${newBudget})`);
    } else if (roas < roasLowThreshold && roas >= 0.8) {
      // 減碼
      const raw = a.dailyBudget * (1 - decreasePercent / 100);
      newBudget = Math.max(Math.round(raw / 10) * 10, minDailyBudget);
      if (newBudget >= a.dailyBudget) continue;
      action = "DECREASE";
      reasons.push(`ROAS ${roas.toFixed(2)} < ${roasLowThreshold}（未到暫停線）建議減碼 -${decreasePercent}% (NT$${a.dailyBudget} → NT$${newBudget})`);
    } else {
      continue; // ROAS 介於合理區間，不動
    }

    const dailyChange = newBudget - a.dailyBudget;
    proposals.push({
      adsetId: a.id,
      adsetName: a.name,
      campaignId: a.campaignId,
      currentDailyBudget: a.dailyBudget,
      newDailyBudget: newBudget,
      dailyChange,
      monthlyChange: dailyChange * 30,
      ageDays: a.ageDays,
      spend: a.insights.spend,
      roas,
      ctr: a.insights.ctr,
      purchases: a.insights.purchases,
      revenue: a.insights.revenue,
      action,
      reasons,
    });
  }

  // 排序：先加碼（高 ROAS）再減碼（低 ROAS）；同類別下變動金額大的優先
  proposals.sort((x, y) => {
    if (x.action !== y.action) return x.action === "INCREASE" ? -1 : 1;
    return Math.abs(y.dailyChange) - Math.abs(x.dailyChange);
  });

  return proposals.slice(0, maxProposals);
}


// ─────────────────────── Meta Ad Library (T2 · Phase 1 Feature 5) ───────────────────────
// 公開資料：任何品牌正在跑的 Meta 廣告（FB/IG）。
// API 端點：https://graph.facebook.com/v21.0/ads_archive
// 需要 `ads_archive` 權限。token 開了 ads_management 通常含 ads_archive 唯讀。

async function searchAdsLibrary({ searchTerms, country = "TW", limit = 25, adType = "ALL" } = {}) {
  if (!tokenOk()) throw new Error("META_ACCESS_TOKEN not set");
  if (!searchTerms) throw new Error("searchTerms required");

  const fields = [
    "id",
    "ad_creation_time",
    "ad_delivery_start_time",
    "ad_delivery_stop_time",
    "ad_creative_bodies",
    "ad_creative_link_titles",
    "ad_creative_link_descriptions",
    "ad_snapshot_url",
    "page_id",
    "page_name",
    "publisher_platforms",
    "languages",
    "impressions",
    "spend",
    "currency",
  ].join(",");

  const params = new URLSearchParams({
    search_terms: searchTerms,
    ad_reached_countries: `["${country}"]`,
    ad_type: adType,
    fields,
    limit: String(limit),
    access_token: process.env.META_ACCESS_TOKEN,
  });
  const url = `${GRAPH}/ads_archive?${params.toString()}`;
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const err = new Error(`Ad Library error: ${body.error?.message || `HTTP ${res.status}`}`);
    err.status = res.status;
    err.graphError = body.error;
    throw err;
  }

  const ads = (body.data || []).map(a => ({
    id: a.id,
    pageId: a.page_id,
    pageName: a.page_name,
    creativeBody: (a.ad_creative_bodies || [])[0] || null,
    linkTitle: (a.ad_creative_link_titles || [])[0] || null,
    linkDesc: (a.ad_creative_link_descriptions || [])[0] || null,
    snapshotUrl: a.ad_snapshot_url,
    startTime: a.ad_delivery_start_time,
    stopTime: a.ad_delivery_stop_time || null,
    platforms: a.publisher_platforms || [],
    languages: a.languages || [],
    impressions: a.impressions || null,
    spend: a.spend || null,
    currency: a.currency || null,
  }));

  return {
    searchTerms,
    country,
    adType,
    count: ads.length,
    ads,
    publicLibraryUrl: `https://www.facebook.com/ads/library/?ad_type=all&country=${country}&q=${encodeURIComponent(searchTerms)}`,
  };
}

// 內建競品名單（MACARON DE LUXE / 溫點適用）
const DEFAULT_COMPETITORS = [
  { name: "法朋", slug: "lefait", category: "高端" },
  { name: "Ladurée", slug: "laduree", category: "國際精品" },
  { name: "Pierre Hermé", slug: "pierre-herme", category: "國際精品" },
  { name: "亞尼克", slug: "yannick", category: "中階" },
  { name: "鐵塔牌", slug: "eiffel-tower", category: "中階" },
];

async function scanCompetitors({ competitors = null, country = "TW", limit = 10 } = {}) {
  const list = competitors || DEFAULT_COMPETITORS;
  const results = [];
  for (const c of list) {
    try {
      const r = await searchAdsLibrary({ searchTerms: c.name, country, limit });
      results.push({
        competitor: c.name,
        category: c.category,
        adCount: r.count,
        ads: r.ads,
        publicLibraryUrl: r.publicLibraryUrl,
        success: true,
      });
    } catch (err) {
      results.push({
        competitor: c.name,
        category: c.category,
        adCount: 0,
        ads: [],
        publicLibraryUrl: `https://www.facebook.com/ads/library/?ad_type=all&country=${country}&q=${encodeURIComponent(c.name)}`,
        success: false,
        error: String(err.message || err),
      });
    }
  }
  return {
    country,
    scannedAt: new Date().toISOString(),
    competitors: results,
    totalAds: results.reduce((sum, r) => sum + r.adCount, 0),
  };
}


// ─────────────────────── Social publishing (T3 · Phase 1 Feature 4) ───────────────────────
// 需要額外 Meta 權限：
//   pages_manage_posts    → FB Page 發文
//   instagram_content_publish → IG 商業帳號發文
//
// FB Page token 跟 User token 不同：發 Page 貼文建議用 Page Access Token。
// 但只要 User token 有 pages_manage_posts 權限，呼叫 /{page-id}/feed 也能發（只是 impersonate 會受限）。
// 我們先以 User token 打，失敗再提示。

async function publishFbPost({ pageId = process.env.META_FB_PAGE_ID, message, link = null } = {}) {
  if (!pageId) throw new Error("FB pageId not set");
  if (!message || message.trim().length < 5) throw new Error("message too short (min 5 chars)");
  const body = { message };
  if (link) body.link = link;
  return await graphPost(`/${pageId}/feed`, body);
}

// IG 發文是 2-step：
//   1) POST /{ig-user-id}/media  → 取 creation_id
//   2) POST /{ig-user-id}/media_publish  creation_id=X
// 必須提供一個公開可讀的圖片 URL（Meta 會去抓）
async function publishIgImagePost({ igUserId = process.env.META_IG_USER_ID, imageUrl, caption = "" } = {}) {
  if (!igUserId) throw new Error("IG user id not set");
  if (!imageUrl) throw new Error("imageUrl required");
  // Step 1: 建立 media container
  const step1 = await graphPost(`/${igUserId}/media`, {
    image_url: imageUrl,
    caption,
  });
  const creationId = step1?.id;
  if (!creationId) throw new Error("Step 1 did not return creation id");
  // Step 2: publish
  const step2 = await graphPost(`/${igUserId}/media_publish`, {
    creation_id: creationId,
  });
  return {
    creationId,
    publishedId: step2?.id,
    step1,
    step2,
  };
}


// POST /{page-id}/photos — FB 圖文貼文
async function publishFbPhoto({ pageId = process.env.META_FB_PAGE_ID, imageUrl, message = "", published = true } = {}) {
  if (!pageId) throw new Error("FB pageId not set");
  if (!imageUrl) throw new Error("imageUrl required");
  return await graphPost(`/${pageId}/photos`, {
    url: imageUrl,
    caption: message,
    published: String(published),
  });
}


// ============================================================
// Token 自動刷新 (T10)
// ============================================================
// 用 META_APP_ID + META_APP_SECRET 把現有 user token 換成 60 天 long-lived
// 再從 long-lived user token 換 page access token（永不過期）

async function refreshUserToken() {
  if (!process.env.META_APP_ID || !process.env.META_APP_SECRET) {
    throw new Error("META_APP_ID / META_APP_SECRET 未設定");
  }
  if (!process.env.META_ACCESS_TOKEN) {
    throw new Error("META_ACCESS_TOKEN 未設定");
  }
  const url = `https://graph.facebook.com/v18.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(process.env.META_APP_ID)}&client_secret=${encodeURIComponent(process.env.META_APP_SECRET)}&fb_exchange_token=${encodeURIComponent(process.env.META_ACCESS_TOKEN)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(`refresh failed: ${data.error?.message || res.status}`);
  // data: { access_token, token_type, expires_in }
  return {
    token: data.access_token,
    expiresIn: data.expires_in, // seconds, 通常 ~5184000 (60 天)
    expiresAt: new Date(Date.now() + (data.expires_in || 5184000) * 1000).toISOString(),
  };
}

async function getLongLivedPageToken() {
  // 從 current user token 拿 page token（若來自 long-lived user token，則 page token 永不過期）
  const data = await graphGet(`/me/accounts?fields=id,name,access_token&access_token=${process.env.META_ACCESS_TOKEN}`);
  const pages = data?.data || [];
  return pages.map(p => ({ id: p.id, name: p.name, pageToken: p.access_token }));
}

async function inspectToken(token) {
  // 用 App Token 查某個 token 的 debug 資訊（過期時間、scope...）
  if (!process.env.META_APP_ID || !process.env.META_APP_SECRET) return { error: "App ID/Secret 未設定" };
  const appToken = `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`;
  const url = `https://graph.facebook.com/v18.0/debug_token?input_token=${encodeURIComponent(token || process.env.META_ACCESS_TOKEN)}&access_token=${encodeURIComponent(appToken)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) return { error: data.error?.message };
  return data.data;
}

async function getTokenStatus() {
  const out = { tokenSet: tokenOk(), appConfigured: !!(process.env.META_APP_ID && process.env.META_APP_SECRET) };
  if (!out.tokenSet) return out;
  try {
    const info = await inspectToken(process.env.META_ACCESS_TOKEN);
    out.tokenInfo = info;
    if (info?.expires_at) {
      out.expiresAt = new Date(info.expires_at * 1000).toISOString();
      const daysLeft = Math.floor((info.expires_at * 1000 - Date.now()) / (24*3600*1000));
      out.daysLeft = daysLeft;
      out.needRefresh = daysLeft < 10;
    } else if (info?.expires_at === 0) {
      out.expiresAt = "never"; // Page token 永不過期
      out.daysLeft = Infinity;
    }
    if (info?.scopes) out.scopes = info.scopes;
    if (info?.type) out.tokenType = info.type;
  } catch (e) {
    out.tokenInfo = { error: String(e.message || e) };
  }
  return out;
}

module.exports = {
  refreshUserToken,
  getLongLivedPageToken,
  inspectToken,
  getTokenStatus,
  tokenOk,
  graphGet,
  graphPost,
  getStatus,
  getFbPagePosts,
  getIgMedia,
  getAdsInsights,
  getAdCampaigns,
  getAdsWithInsights,
  getAdSetsWithInsights,
  updateEntityStatus,
  updateAdSetBudget,
  updateCampaignBudget,
  pauseAd, resumeAd,
  pauseAdSet, resumeAdSet,
  pauseCampaign, resumeCampaign,
  proposePausesFromAds,
  proposeBudgetChangesFromAdSets,
  searchAdsLibrary,
  scanCompetitors,
  DEFAULT_COMPETITORS,
  publishFbPost,
  publishFbPhoto,
  publishIgImagePost,
  buildLiveDataBlock,
  buildCoachDataBlock,
};
