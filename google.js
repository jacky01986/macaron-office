// ============================================================
// MACARON DE LUXE · Google Ads API Client (T5)
// ============================================================
// 所需 env vars:
//   GOOGLE_ADS_DEVELOPER_TOKEN   (MCC API Center 拿的 token)
//   GOOGLE_ADS_CLIENT_ID         (OAuth client ID)
//   GOOGLE_ADS_CLIENT_SECRET     (OAuth client secret)
//   GOOGLE_ADS_REFRESH_TOKEN     (OAuth refresh token)
//   GOOGLE_ADS_CUSTOMER_ID       (10 位數帳戶 ID，不要連字號)
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID (可選：MCC 帳戶 ID)

const API_VERSION = "v17";
const API_BASE = `https://googleads.googleapis.com/${API_VERSION}`;

// in-memory access token cache
let _cachedAccessToken = null;
let _cachedAccessTokenExp = 0;

function tokenOk() {
  return !!(
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN &&
    process.env.GOOGLE_ADS_CLIENT_ID &&
    process.env.GOOGLE_ADS_CLIENT_SECRET &&
    process.env.GOOGLE_ADS_REFRESH_TOKEN &&
    process.env.GOOGLE_ADS_CUSTOMER_ID
  );
}

function status() {
  return {
    developerToken: !!process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    clientId: !!process.env.GOOGLE_ADS_CLIENT_ID,
    clientSecret: !!process.env.GOOGLE_ADS_CLIENT_SECRET,
    refreshToken: !!process.env.GOOGLE_ADS_REFRESH_TOKEN,
    customerId: !!process.env.GOOGLE_ADS_CUSTOMER_ID,
    loginCustomerId: !!process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
    allReady: tokenOk(),
  };
}

// 取得 access token（自動用 refresh token 換，cache 1 小時）
async function getAccessToken() {
  const now = Date.now();
  if (_cachedAccessToken && now < _cachedAccessTokenExp) return _cachedAccessToken;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OAuth refresh failed: ${res.status} ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  _cachedAccessToken = data.access_token;
  // token 通常 1 小時，提早 5 分鐘重新換
  _cachedAccessTokenExp = now + ((data.expires_in || 3600) - 300) * 1000;
  return _cachedAccessToken;
}

function buildHeaders(accessToken) {
  const h = {
    "Authorization": `Bearer ${accessToken}`,
    "developer-token": process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    "Content-Type": "application/json",
  };
  if (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
    h["login-customer-id"] = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID.replace(/\D/g, "");
  }
  return h;
}

// 執行 GAQL query（Google Ads Query Language）
async function gaql(query) {
  if (!tokenOk()) throw new Error("Google Ads env vars not set");
  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID.replace(/\D/g, "");
  const accessToken = await getAccessToken();
  const res = await fetch(
    `${API_BASE}/customers/${customerId}/googleAds:search`,
    {
      method: "POST",
      headers: buildHeaders(accessToken),
      body: JSON.stringify({ query, pageSize: 1000 }),
    }
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || `HTTP ${res.status}`;
    const details = JSON.stringify(body?.error?.details || body?.error || {}).slice(0, 500);
    throw new Error(`Google Ads API: ${msg} | ${details}`);
  }
  return body.results || [];
}

// 微值轉元：Google Ads 用 micros (百萬分之一) 表示金額
function microsToCurrency(micros) {
  if (micros == null) return 0;
  return Number(micros) / 1_000_000;
}

function safeDiv(a, b) {
  if (!b || b === 0) return 0;
  return a / b;
}

// ---- 報表函式 ----

// Campaigns with metrics (last 7/30 days)
async function getCampaigns({ dateRange = "LAST_7_DAYS" } = {}) {
  const q = `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      campaign_budget.amount_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value,
      metrics.ctr,
      metrics.average_cpc
    FROM campaign
    WHERE segments.date DURING ${dateRange}
    ORDER BY metrics.cost_micros DESC
  `;
  const rows = await gaql(q);
  return rows.map(r => ({
    id: r.campaign?.id,
    name: r.campaign?.name,
    status: r.campaign?.status,
    channel: r.campaign?.advertisingChannelType,
    dailyBudget: microsToCurrency(r.campaignBudget?.amountMicros),
    impressions: Number(r.metrics?.impressions || 0),
    clicks: Number(r.metrics?.clicks || 0),
    cost: microsToCurrency(r.metrics?.costMicros),
    conversions: Number(r.metrics?.conversions || 0),
    conversionsValue: Number(r.metrics?.conversionsValue || 0),
    ctr: Number(r.metrics?.ctr || 0),
    avgCpc: microsToCurrency(r.metrics?.averageCpc),
    roas: safeDiv(Number(r.metrics?.conversionsValue || 0), microsToCurrency(r.metrics?.costMicros)),
  }));
}

// Ad groups with metrics
async function getAdGroups({ dateRange = "LAST_7_DAYS", campaignId } = {}) {
  const where = campaignId
    ? `WHERE segments.date DURING ${dateRange} AND campaign.id = ${campaignId}`
    : `WHERE segments.date DURING ${dateRange}`;
  const q = `
    SELECT
      ad_group.id,
      ad_group.name,
      ad_group.status,
      campaign.id,
      campaign.name,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM ad_group
    ${where}
    ORDER BY metrics.cost_micros DESC
  `;
  const rows = await gaql(q);
  return rows.map(r => ({
    id: r.adGroup?.id,
    name: r.adGroup?.name,
    status: r.adGroup?.status,
    campaignId: r.campaign?.id,
    campaignName: r.campaign?.name,
    impressions: Number(r.metrics?.impressions || 0),
    clicks: Number(r.metrics?.clicks || 0),
    cost: microsToCurrency(r.metrics?.costMicros),
    conversions: Number(r.metrics?.conversions || 0),
    conversionsValue: Number(r.metrics?.conversionsValue || 0),
    roas: safeDiv(Number(r.metrics?.conversionsValue || 0), microsToCurrency(r.metrics?.costMicros)),
  }));
}

// Keywords with metrics
async function getKeywords({ dateRange = "LAST_7_DAYS" } = {}) {
  const q = `
    SELECT
      ad_group_criterion.criterion_id,
      ad_group_criterion.keyword.text,
      ad_group_criterion.keyword.match_type,
      ad_group_criterion.status,
      ad_group.id,
      ad_group.name,
      campaign.id,
      campaign.name,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value,
      metrics.ctr,
      metrics.average_cpc
    FROM keyword_view
    WHERE segments.date DURING ${dateRange}
    ORDER BY metrics.cost_micros DESC
    LIMIT 500
  `;
  const rows = await gaql(q);
  return rows.map(r => ({
    keywordId: r.adGroupCriterion?.criterionId,
    keyword: r.adGroupCriterion?.keyword?.text,
    matchType: r.adGroupCriterion?.keyword?.matchType,
    status: r.adGroupCriterion?.status,
    adGroupId: r.adGroup?.id,
    adGroupName: r.adGroup?.name,
    campaignId: r.campaign?.id,
    campaignName: r.campaign?.name,
    impressions: Number(r.metrics?.impressions || 0),
    clicks: Number(r.metrics?.clicks || 0),
    cost: microsToCurrency(r.metrics?.costMicros),
    conversions: Number(r.metrics?.conversions || 0),
    conversionsValue: Number(r.metrics?.conversionsValue || 0),
    ctr: Number(r.metrics?.ctr || 0),
    avgCpc: microsToCurrency(r.metrics?.averageCpc),
    roas: safeDiv(Number(r.metrics?.conversionsValue || 0), microsToCurrency(r.metrics?.costMicros)),
  }));
}

// Search terms (users 實際輸入的搜尋字) - 找 negative keyword 候選
async function getSearchTerms({ dateRange = "LAST_7_DAYS" } = {}) {
  const q = `
    SELECT
      search_term_view.search_term,
      search_term_view.status,
      campaign.id,
      campaign.name,
      ad_group.id,
      ad_group.name,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM search_term_view
    WHERE segments.date DURING ${dateRange}
    ORDER BY metrics.cost_micros DESC
    LIMIT 500
  `;
  const rows = await gaql(q);
  return rows.map(r => ({
    term: r.searchTermView?.searchTerm,
    status: r.searchTermView?.status,
    campaignId: r.campaign?.id,
    campaignName: r.campaign?.name,
    adGroupId: r.adGroup?.id,
    adGroupName: r.adGroup?.name,
    impressions: Number(r.metrics?.impressions || 0),
    clicks: Number(r.metrics?.clicks || 0),
    cost: microsToCurrency(r.metrics?.costMicros),
    conversions: Number(r.metrics?.conversions || 0),
    conversionsValue: Number(r.metrics?.conversionsValue || 0),
    roas: safeDiv(Number(r.metrics?.conversionsValue || 0), microsToCurrency(r.metrics?.costMicros)),
  }));
}

// Ads with metrics
async function getAds({ dateRange = "LAST_7_DAYS" } = {}) {
  const q = `
    SELECT
      ad_group_ad.ad.id,
      ad_group_ad.ad.name,
      ad_group_ad.ad.type,
      ad_group_ad.status,
      ad_group.id,
      ad_group.name,
      campaign.id,
      campaign.name,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value,
      metrics.ctr
    FROM ad_group_ad
    WHERE segments.date DURING ${dateRange}
    ORDER BY metrics.cost_micros DESC
    LIMIT 200
  `;
  const rows = await gaql(q);
  return rows.map(r => ({
    adId: r.adGroupAd?.ad?.id,
    adName: r.adGroupAd?.ad?.name,
    type: r.adGroupAd?.ad?.type,
    status: r.adGroupAd?.status,
    adGroupId: r.adGroup?.id,
    adGroupName: r.adGroup?.name,
    campaignId: r.campaign?.id,
    campaignName: r.campaign?.name,
    impressions: Number(r.metrics?.impressions || 0),
    clicks: Number(r.metrics?.clicks || 0),
    cost: microsToCurrency(r.metrics?.costMicros),
    conversions: Number(r.metrics?.conversions || 0),
    conversionsValue: Number(r.metrics?.conversionsValue || 0),
    ctr: Number(r.metrics?.ctr || 0),
    roas: safeDiv(Number(r.metrics?.conversionsValue || 0), microsToCurrency(r.metrics?.costMicros)),
  }));
}

// 頂層總覽：帳戶級累計
async function getAccountSummary({ dateRange = "LAST_7_DAYS" } = {}) {
  const q = `
    SELECT
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM customer
    WHERE segments.date DURING ${dateRange}
  `;
  const rows = await gaql(q);
  if (!rows.length) return null;
  const m = rows[0].metrics || {};
  const cost = microsToCurrency(m.costMicros);
  const value = Number(m.conversionsValue || 0);
  return {
    dateRange,
    impressions: Number(m.impressions || 0),
    clicks: Number(m.clicks || 0),
    cost,
    conversions: Number(m.conversions || 0),
    conversionsValue: value,
    ctr: safeDiv(Number(m.clicks || 0), Number(m.impressions || 0)),
    cpc: safeDiv(cost, Number(m.clicks || 0)),
    roas: safeDiv(value, cost),
  };
}

// Coaching data 給員工 system prompt 用
async function buildCoachDataBlock() {
  if (!tokenOk()) return null;
  try {
    const [summary, campaigns] = await Promise.all([
      getAccountSummary({ dateRange: "LAST_7_DAYS" }),
      getCampaigns({ dateRange: "LAST_7_DAYS" }),
    ]);
    const lines = [];
    if (summary) {
      lines.push(
        `Google Ads 最近 7 天帳戶總覽：曝光 ${summary.impressions.toLocaleString()} · 點擊 ${summary.clicks.toLocaleString()} · 花費 NT$${Math.round(summary.cost).toLocaleString()} · 轉換 ${summary.conversions.toFixed(1)} 次 · 轉換值 NT$${Math.round(summary.conversionsValue).toLocaleString()} · CTR ${(summary.ctr * 100).toFixed(2)}% · 平均 CPC NT$${summary.cpc.toFixed(1)} · ROAS ${summary.roas.toFixed(2)}`
      );
    }
    const enabled = campaigns.filter(c => c.status === "ENABLED");
    if (enabled.length) {
      lines.push(`啟用中 Campaign (${enabled.length} 個)：`);
      enabled.slice(0, 10).forEach(c => {
        lines.push(
          `- ${c.name}：花費 NT$${Math.round(c.cost).toLocaleString()}、點擊 ${c.clicks}、轉換 ${c.conversions.toFixed(1)}、ROAS ${c.roas.toFixed(2)}`
        );
      });
    } else {
      lines.push("目前沒有任何啟用中的 campaign（或該區間無資料）。");
    }
    return lines.join("\n");
  } catch (e) {
    return `Google Ads 資料讀取失敗：${e.message}`;
  }
}

module.exports = {
  tokenOk,
  status,
  gaql,
  getAccessToken,
  getCampaigns,
  getAdGroups,
  getKeywords,
  getSearchTerms,
  getAds,
  getAccountSummary,
  buildCoachDataBlock,
};
