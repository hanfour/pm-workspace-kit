// AcmeAds vertical demo seed (P5a). Writes five AcmeAds-themed
// KnowledgeAtoms so the future `pmk demo` (P5b) + walkthrough (P5c) have
// a coherent, retrievable knowledge set. Mirrors demo-seed.ts: data-
// driven atoms written via saveAtom (format-safe), all tagged with
// ACME_ADS_SEED_TAG so unseed cleans exactly this bundle and never a
// real atom. Distinct from M4's generic "demo-seed" smoke atom.

import * as fs from "node:fs";
import * as path from "node:path";

import {
  type KnowledgeAtom,
  knowledgeRoot,
  loadAtoms,
  safeScope,
  saveAtom,
} from "./knowledge";

export const ACME_ADS_SEED_TAG = "acme-ads-demo";
const ACME_ADS_SCOPE = "acme-ads";

interface AtomSeed {
  key: string;
  question: string;
  answer: string;
  summary: string;
  extraTags: string[];
}

const ATOM_SEEDS: readonly AtomSeed[] = [
  {
    key: "adformat-vs-placement",
    question: "AcmeAds 的 AdFormat 跟 placement 有什麼差別？",
    answer: [
      "AdFormat（廣告版型）指的是廣告的呈現規格——例如橫幅、原生、影音、插頁；它決定素材尺寸、可用的互動元件與計價單位。",
      "placement（版位）則是這個版型實際被放到哪個位置——某個 App 的首頁頂部、文章列表第 3 則、影片前貼。",
      "",
      "一句話：AdFormat 是「長什麼樣」，placement 是「放在哪」。同一個 AdFormat 可以投到很多不同 placement；同一個 placement 也可能支援多種 AdFormat。報表通常以 placement 為最小計量單位，AdFormat 用來分群分析。",
    ].join("\n"),
    summary:
      "AdFormat=廣告版型（規格／計價單位），placement=版位（放在哪）；一對多，報表以 placement 為最小單位。",
    extraTags: ["adformat", "placement", "biz"],
  },
  {
    key: "placement-vcpm",
    question: "某個 placement 的 vCPM 怎麼算？資料在哪看？",
    answer: [
      "vCPM（viewable CPM，可視千次曝光成本）= 該 placement 的營收 ÷ 可視曝光數 × 1000。",
      "",
      "- 分子：placement 在統計區間內的 PlacementRevenue。",
      "- 分母：可視曝光數（viewable impressions，要扣掉未進入可視區、提早關閉的，不是總曝光）。",
      "",
      "資料來源：報表系統的 placement 日彙總表 `placement_daily`，欄位 `revenue` 與 `viewable_impressions`。注意 vCPM 與 CPM 不同——CPM 用總曝光、vCPM 用可視曝光，廣告主結算多半看 vCPM。",
    ].join("\n"),
    summary:
      "vCPM = PlacementRevenue ÷ 可視曝光 × 1000；資料在 placement_daily 的 revenue／viewable_impressions；與 CPM（用總曝光）不同。",
    extraTags: ["vcpm", "placement", "metrics"],
  },
  {
    key: "onboarding-customer-migration",
    question: "self-service onboarding 上線後，舊客戶的資料怎麼遷？",
    answer: [
      "現有客戶不會被自動丟進 self-service 流程。依 onboarding PRD（PRD-2026-0001）與 crm-customer-migration module 的設計，遷移是分批、可回滾的：",
      "",
      "1. 既有客戶資料維持在舊 CRM 表，self-service 只接新註冊；",
      "2. 背景 job 依 batch 把舊客戶 profile 對映到新 schema（Strangler Fig，見 ADR-0004 的 go-monolith 脈絡）；",
      "3. 每批遷移後跑對帳，異常的留在舊表、不阻擋新流程。",
      "",
      "所以「上線」對舊客戶是無感的——他們不會突然被要求重新 onboard。",
    ].join("\n"),
    summary:
      "舊客戶不自動進 self-service；依 PRD-2026-0001 + crm-customer-migration module 分批可回滾遷移（Strangler Fig），對帳異常留舊表、不阻擋新流程。",
    extraTags: ["onboarding", "migration", "crm"],
  },
  {
    key: "placementrevenue-vs-accountpayable",
    question: "PlacementRevenue 跟 AccountPayable 差在哪？財報上看哪個？",
    answer: [
      "兩個是不同方向的錢：",
      "",
      "- PlacementRevenue：AcmeAds 從廣告主那邊「收進來」的版位營收（收入端）。",
      "- AccountPayable：AcmeAds 要「付出去」的——主要是付給 media／publisher 的分潤與供應商應付帳款（支出端）。",
      "",
      "損益表（P&L）上，PlacementRevenue 計入營收（top line）；publisher 分潤是成本，其未付部分落在資產負債表的 AccountPayable。看「賺多少」用 PlacementRevenue，看「欠多少待付」用 AccountPayable，兩者不能互相替代。",
    ].join("\n"),
    summary:
      "PlacementRevenue=收入端（廣告主版位營收，P&L top line）；AccountPayable=支出端應付（付 publisher 分潤等，落資產負債表）。方向相反、不可互換。",
    extraTags: ["placementrevenue", "accountpayable", "finance", "biz"],
  },
  {
    key: "onboarding-dedup-module",
    question: "customer onboarding 的客戶去重（dedup）規則寫在哪個 module？",
    answer: [
      "去重規則的需求定義在 PRD-2026-0003（`docs/prds/2026-Q2-onboarding-dedup-prd.md`）；模組邊界與所有權在 `crm.customer`（由 crm-customer-migration playbook 持有）。比對主鍵：normalized email + 公司統編；命中視為同一客戶、合併 profile，衝突欄位以最近一次 self-service 提交為準。",
      "",
      "如果你要的是實作層的確切函式／檔案位置，這條 PKB 只到 module 邊界；再深一層要問 IT（gateway 會自動 mra-ask 對應 repo，必要時 escalate 給負責 crm.customer 的工程師）。",
    ].join("\n"),
    summary:
      "去重規則的需求定義在 PRD-2026-0003，模組邊界在 crm.customer（crm-customer-migration playbook 持有）；主鍵 normalized email + 統編，命中合併、衝突取最近 self-service 提交；更深的實作位置需 mra-ask／escalate。",
    extraTags: ["dedup", "onboarding", "crm", "code"],
  },
];

export interface AcmeAdsSeedResult {
  atomIds: string[];
  alreadyPresent: boolean;
}

export interface AcmeAdsUnseedResult {
  removedIds: string[];
}

function atomFromSeed(seed: AtomSeed): KnowledgeAtom {
  return {
    id: `acme-ads-${seed.key}`,
    createdAt: Date.now(),
    scope: ACME_ADS_SCOPE,
    question: seed.question,
    answer: seed.answer,
    summary: seed.summary,
    tags: [ACME_ADS_SEED_TAG, ...seed.extraTags],
    source: { threadKey: "acme-ads:demo", contributorUserId: "ACME_ADS_DEMO" },
    status: "approved",
  };
}

export function findAcmeAdsAtoms(): KnowledgeAtom[] {
  return loadAtoms({ promote: false }).filter((a) =>
    a.tags.includes(ACME_ADS_SEED_TAG),
  );
}

function atomFilePath(atom: KnowledgeAtom): string {
  return path.join(knowledgeRoot(), safeScope(atom.scope), `${atom.id}.md`);
}

export function seedAcmeAdsAtoms(): AcmeAdsSeedResult {
  const existing = findAcmeAdsAtoms();
  if (existing.length > 0) {
    return { atomIds: existing.map((a) => a.id), alreadyPresent: true };
  }
  const ids: string[] = [];
  for (const seed of ATOM_SEEDS) {
    const atom = atomFromSeed(seed);
    saveAtom(atom);
    ids.push(atom.id);
  }
  return { atomIds: ids, alreadyPresent: false };
}

export function unseedAcmeAdsAtoms(): AcmeAdsUnseedResult {
  const removedIds: string[] = [];
  for (const atom of findAcmeAdsAtoms()) {
    try {
      fs.unlinkSync(atomFilePath(atom));
      removedIds.push(atom.id);
    } catch {
      // best-effort: file may have vanished between load and unlink
    }
  }
  return { removedIds };
}
