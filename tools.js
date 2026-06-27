// ============================================================
// 溫點 WarmPlace · AI Agent 工具系統 (T9)
// ============================================================
// 每個工具 = Claude 員工可以呼叫的真實動作
// READ tools 立即執行、WRITE tools 回傳 "proposal" 讓使用者確認

// 工具分類：
// READ = 安全，直接執行（查資料、列清單、讀設定）
// WRITE = 需要使用者確認（發文、暫停廣告、改預算、push LINE）

const TOOL_DEFINITIONS = {
  // ========== Meta 廣告 READ ==========
  get_meta_summary: {
    category: "read",
    description: "取得 Meta 廣告帳戶最近 N 天的總覽（曝光、點擊、花費、轉換、ROAS）",
    input_schema: {
      type: "object",
      properties: {
        datePreset: {
          type: "string",
          enum: ["today", "yesterday", "last_7d", "last_14d", "last_30d", "last_90d"],
          description: "時間區間"
        }
      },
      required: ["datePreset"]
    }
  },
  get_meta_campaigns: {
    category: "read",
    description: "列出 Meta 廣告活動（campaign）清單 + 每一支的表現",
    input_schema: {
      type: "object",
      properties: {
        datePreset: { type: "string", enum: ["today", "yesterday", "last_7d", "last_14d", "last_30d"], description: "時間區間" },
        limit: { type: "number", description: "最多回傳幾筆，預設 25" }
      },
      required: ["datePreset"]
    }
  },
  get_meta_ads: {
    category: "read",
    description: "列出 Meta 廣告（ad level）清單 + 表現，可篩選 ROAS 範圍",
    input_schema: {
      type: "object",
      properties: {
        datePreset: { type: "string", enum: ["last_7d", "last_14d", "last_30d"] },
        limit: { type: "number" }
      },
      required: ["datePreset"]
    }
  },
  get_meta_adsets: {
    category: "read",
    description: "列出 Meta ad sets（廣告組合）+ 每組表現與預算，Leon 調預算時用",
    input_schema: {
      type: "object",
      properties: {
        datePreset: { type: "string", enum: ["last_7d", "last_14d", "last_30d"] },
      },
      required: ["datePreset"]
    }
  },

  // ========== Meta 競品 READ ==========
  scan_competitors: {
    category: "read",
    description: "掃描 Meta Ad Library 看競品現在投什麼廣告",
    input_schema: {
      type: "object",
      properties: {
        brand: { type: "string", description: "競品品牌名（可選，留空看預設清單）" }
      }
    }
  },

  // ========== LINE 客服 READ ==========
  list_line_messages: {
    category: "read",
    description: "列出客人最近的 LINE 訊息（包含尚未回覆的）",
    input_schema: {
      type: "object",
      properties: {
        onlyPending: { type: "boolean", description: "只列出尚未回覆的", },
        limit: { type: "number" }
      }
    }
  },
  get_customer_profile: {
    category: "read",
    description: "拿某位客人的完整資料：RFM 分組、對話歷史、AI 畫像（若已生成）",
    input_schema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "LINE userId" }
      },
      required: ["userId"]
    }
  },
  list_customers_in_segment: {
    category: "read",
    description: "列出某一組客人（VIP / 活躍 / 新客 / 潛在流失）",
    input_schema: {
      type: "object",
      properties: {
        segment: { type: "string", enum: ["vip", "active", "new", "atrisk"] }
      },
      required: ["segment"]
    }
  },

  // ========== Google Ads READ ==========
  get_google_summary: {
    category: "read",
    description: "Google Ads 帳戶最近表現（若有設 token）",
    input_schema: {
      type: "object",
      properties: {
        dateRange: { type: "string", enum: ["LAST_7_DAYS", "LAST_14_DAYS", "LAST_30_DAYS"] }
      }
    }
  },

  // ========== 整體健康 READ ==========
  get_account_health: {
    category: "read",
    description: "跨平台健康儀表：Meta 廣告 + LINE 待回訊息 + Google Ads + 客人分組，最近 7 天",
    input_schema: { type: "object", properties: {} }
  },

  // ========== Meta 廣告 WRITE (半自動) ==========
  propose_pause_ads: {
    category: "write",
    description: "提案暫停一批爛廣告。回傳提案清單給使用者確認，不會立刻執行。",
    input_schema: {
      type: "object",
      properties: {
        adIds: { type: "array", items: { type: "string" }, description: "要暫停的廣告 ID 清單" },
        reason: { type: "string", description: "暫停原因摘要，給人看的" }
      },
      required: ["adIds", "reason"]
    }
  },
  propose_budget_changes: {
    category: "write",
    description: "提案調整 ad set 預算。半自動，需使用者確認。",
    input_schema: {
      type: "object",
      properties: {
        changes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              adSetId: { type: "string" },
              adSetName: { type: "string" },
              oldDaily: { type: "number" },
              newDaily: { type: "number" },
              reason: { type: "string" }
            },
            required: ["adSetId", "newDaily"]
          }
        }
      },
      required: ["changes"]
    }
  },

  // ========== FB/IG 發文 WRITE ==========
  propose_fb_post: {
    category: "write",
    description: "提案一則 FB 貼文（文案 + 可選圖片 URL），使用者確認後才發",
    input_schema: {
      type: "object",
      properties: {
        caption: { type: "string", description: "完整文案" },
        imageUrl: { type: "string", description: "（可選）圖片 HTTPS URL" },
        link: { type: "string", description: "（可選）外部連結" }
      },
      required: ["caption"]
    }
  },
  propose_ig_post: {
    category: "write",
    description: "提案一則 IG 貼文（必須有圖片 URL）",
    input_schema: {
      type: "object",
      properties: {
        caption: { type: "string" },
        imageUrl: { type: "string", description: "HTTPS 圖片 URL，IG 必填" }
      },
      required: ["caption", "imageUrl"]
    }
  },

  // ========== LINE WRITE ==========
  propose_line_reply: {
    category: "write",
    description: "提案一則 LINE 客服回覆。半自動，使用者確認後發送",
    input_schema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "要回覆的客人訊息 ID" },
        text: { type: "string", description: "回覆內容" },
        imageUrl: { type: "string", description: "（可選）附圖 URL" },
        linkUrl: { type: "string", description: "（可選）連結" },
        linkLabel: { type: "string", description: "（可選）連結按鈕文字" }
      },
      required: ["messageId", "text"]
    }
  },
  propose_segment_push: {
    category: "write",
    description: "對一組客人（VIP/活躍/新客/潛在流失）推播 LINE。半自動，使用者確認後才發。",
    input_schema: {
      type: "object",
      properties: {
        segment: { type: "string", enum: ["vip", "active", "new", "atrisk"] },
        text: { type: "string", description: "訊息內容" },
        imageUrl: { type: "string" },
        linkUrl: { type: "string" },
        linkLabel: { type: "string" }
      },
      required: ["segment", "text"]
    }
  },

  // ── ③ 真實對話讀取 (給 HANA/RINA 學語氣) ──
  fetch_conversation_detail: {
    category: "read",
    description: "抓 SaleSmartly 上某個客戶的完整對話歷史 (Meta Messenger/IG DM/LINE). HANA 用來學 Sam 的回覆語氣; RINA 用來找客戶常問的痛點當 Reels 題材.",
    input_schema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "SaleSmartly chat_user_id, 若不知道留空可拿最近 5 筆" },
        limit: { type: "number", description: "抓多少則訊息, 預設 30" }
      }
    }
  },
  // ── ⑤ 專案經理派工 (給 JUNE) ──
  delegate_to_employee: {
    category: "read",
    description: "把子任務派給其他 AI 員工 (CAMILLE/NOVA/ARIA/DEX/RINA/HANA/SOLA/MIRA). 員工會用自己的 system prompt 跑一輪, 你拿到後再整合. 用於 JUNE 排專案、VICTOR 分派.",
    input_schema: {
      type: "object",
      properties: {
        employee: { type: "string", description: "員工代號小寫, 例如 camille/nova/rina" },
        task: { type: "string", description: "明確任務描述, 含背景與想要的產出" }
      },
      required: ["employee", "task"]
    }
  },

  // ── (1) 讀自家 FB + IG 歷史貼文 + 互動數 (學成功公式) ──
  get_offline_reports: { description: 'Query offline reports center: aggregated stats from manually uploaded branch/department reports (revenue, problems, action items, reviews). Returns 30-day report count, total revenue, recent problem points, and brief of recent 5 reports. Use this to discuss branch performance, recurring issues, and operational feedback from the team.', input_schema: { type: 'object', properties: {} } }, get_shopline_brief: { category: "read", description: "拿溫點 WarmPlace 即時 Shopline 商業 brief: 今日/7日訂單摘要 + 熱賣 SKU + VIP 客人 + 商品庫存 + 進行中促銷. 寫策略/早報/客人應對前先 call.", input_schema: { type: "object", properties: {} } }, get_meta_posts: {
    category: "read",
    description: "抓 溫點 WarmPlace 自己 FB Page + IG 最近 N 篇貼文 + 互動數 (讚/留言/分享). 用來分析哪種文案/視覺/題材成效最好, 學成功公式. 寫新內容前先 call 一次.",
    input_schema: {
      type: "object",
      properties: {
        platform: { type: "string", enum: ["fb", "ig", "both"], description: "fb=只 FB, ig=只 IG, both=兩個都拿" },
        limit: { type: "number", description: "每平台抓幾篇, 預設 10" }
      }
    }
  },

  // ── FILES 員工專屬：生成 Word / Excel / PDF / PPT ──
  generate_docx: {
    category: "read",
    description: "生成 Word (.docx) 並回傳下載 URL. 用於把對話、報告、提案、會議紀錄轉成可下載 Word.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "文件標題" },
        sections: { type: "array", description: "段落陣列, 每段 {heading, body}", items: { type: "object", properties: { heading: { type: "string" }, body: { type: "string" } } } }
      },
      required: ["title", "sections"]
    }
  },
  generate_xlsx: {
    category: "read",
    description: "生成 Excel (.xlsx) 並回傳下載 URL. 用於把表格資料、客戶清單、價目、KPI、行事曆等做成 Excel.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "活頁簿名稱" },
        sheets: { type: "array", description: "工作表陣列, 每張 {name, headers, rows}", items: { type: "object", properties: { name: { type: "string" }, headers: { type: "array", items: { type: "string" } }, rows: { type: "array", items: { type: "array" } } } } }
      },
      required: ["title", "sheets"]
    }
  },
  generate_pdf: {
    category: "read",
    description: "生成 PDF 並回傳下載 URL. 用於可印出版型, 例如給供應商看、合約、提案. 支援中文.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        sections: { type: "array", items: { type: "object", properties: { heading: { type: "string" }, body: { type: "string" } } } }
      },
      required: ["title", "sections"]
    }
  },
  generate_pptx: {
    category: "read",
    description: "生成 PowerPoint (.pptx) 並回傳下載 URL. 用於簡報、提案、培訓投影片.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        slides: { type: "array", description: "投影片陣列 {title, bullets[] 或 body}", items: { type: "object", properties: { title: { type: "string" }, bullets: { type: "array", items: { type: "string" } }, body: { type: "string" }, footer: { type: "string" } } } }
      },
      required: ["title", "slides"]
    }
  },
  // ── ① web_search marker — asAnthropicTools 會轉成 Anthropic 原生 server-tool ──
  web_search: {
    category: "native",
    description: "Anthropic 原生 web_search (不在 executeReadTool 處理, 由 model server-side 自動跑)",
    input_schema: { type: "object", properties: {} }
  },
  // ========== AiToEarn 跨平台 (MCP bridge) ==========
  aitoearn_list_actions: {
    category: "read",
    description: "列出 AiToEarn 可用的跨平台動作（發布/互動/生成/變現）。用來查 TikTok/小紅書/YouTube/X/Threads/Pinterest 等內建工具沒涵蓋的渠道能做什麼。先查到動作名稱，再用 aitoearn_publish 執行。",
    input_schema: { type: "object", properties: {} }
  },
  aitoearn_publish: {
    category: "write",
    description: "透過 AiToEarn 對其他平台（TikTok/小紅書/YouTube/X/Threads/Pinterest 等）執行一個動作。半自動，使用者確認後才送。action 必須是 aitoearn_list_actions 查到的名稱。",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", description: "AiToEarn 動作名稱（來自 aitoearn_list_actions）" },
        params: { type: "object", description: "該動作所需參數（平台、文案、媒體 URL、排程時間等）" },
        note: { type: "string", description: "給人看的摘要：要發什麼、到哪個平台" }
      },
      required: ["action", "params"]
    }
  },
};

// 把 tool definition 轉成 Anthropic Tool Use API 格式
function asAnthropicTools(toolNames) {
  return toolNames
    .filter(n => TOOL_DEFINITIONS[n])
    .map(n => {
      // ① 原生 web_search → Anthropic server-tool 格式
      if (n === 'web_search' || TOOL_DEFINITIONS[n].category === 'native') {
        return { type: 'web_search_20250305', name: 'web_search', max_uses: 4 };
      }
      return {
        name: n,
        description: TOOL_DEFINITIONS[n].description,
        input_schema: TOOL_DEFINITIONS[n].input_schema,
      };
    });
}

function isWriteTool(name) {
  return TOOL_DEFINITIONS[name]?.category === "write";
}

function getAllToolNames() {
  return Object.keys(TOOL_DEFINITIONS);
}

module.exports = {
  TOOL_DEFINITIONS,
  asAnthropicTools,
  isWriteTool,
  getAllToolNames,
};
