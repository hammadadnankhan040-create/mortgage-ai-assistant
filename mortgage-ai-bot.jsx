import { useState, useRef, useCallback } from "react";

const C = {
  bg:"#0a0e1a", panel:"#111827", card:"#1a2235", border:"#1e2d45",
  accent:"#0ea5e9", gold:"#f59e0b", success:"#10b981", warning:"#f59e0b",
  danger:"#ef4444", text:"#e2e8f0", muted:"#64748b", subtle:"#334155",
};

const DOC_TYPES = [
  { id:"id_doc",           label:"Proof of ID",               icon:"🪪", desc:"Passport, driving licence, BRP card",                           maxFiles:1, minSuggested:1, multi:false },
  { id:"proof_address",    label:"Proof of Address",          icon:"🏠", desc:"Utility bill or bank statement within 3 months",                maxFiles:1, minSuggested:1, multi:false },
  { id:"bank_statements",  label:"Bank Statements",           icon:"🏦", desc:"Upload at least 3 months — up to 6",                           maxFiles:6, minSuggested:3, multi:true  },
  { id:"payslips",         label:"Payslips",                  icon:"💷", desc:"Upload at least 3 consecutive months",                         maxFiles:6, minSuggested:3, multi:true  },
  { id:"p60_p45",          label:"P60 / P45",                 icon:"📄", desc:"P60s and/or P45s — P45 valid where client left employer",       maxFiles:4, minSuggested:1, multi:true  },
  { id:"sa302",            label:"SA302 / Tax Year Overview", icon:"📋", desc:"2x SA302 + 2x Tax Year Overview",                              maxFiles:4, minSuggested:2, multi:true  },
  { id:"company_accounts", label:"Company Accounts",          icon:"🏢", desc:"Up to 3 years accounts for directors/shareholders",            maxFiles:3, minSuggested:1, multi:true  },
  { id:"credit_report",    label:"Credit Report",             icon:"📊", desc:"Full credit report (Experian/Equifax/TransUnion)",              maxFiles:1, minSuggested:1, multi:false },
  { id:"gift_letter",      label:"Gifted Deposit",            icon:"🎁", desc:"Gift letter + donor ID + donor bank statement (if applicable)", maxFiles:3, minSuggested:1, multi:true  },
];

// ── System prompts per document type ─────────────────────────────────────────

const BASE = `You are a UK mortgage compliance assistant for a professional mortgage administrator.
Return ONLY valid JSON — no prose, no markdown, no code fences.
Format: {"document_type":"string","key_data":{"field":"value"},"rule_checks":[{"rule":"string","check":"string","result":"PASS|FAIL|FLAG|N/A","detail":"string"}],"flags":[{"severity":"HIGH|MEDIUM|LOW","rule_ref":"string","message":"string"}],"summary":"string","passed":true}
Max 10 rule_checks. Max 8 flags. Be specific — name amounts, dates, exact values where visible.`;

const MULTI = `
MULTI-DOCUMENT DETECTION: This file may contain multiple documents or periods. Scan entire file. Analyse ALL. Report key data per document as doc_1, doc_2 etc. Note in summary how many documents found.`;

const PROMPTS = {
  id_doc: BASE + `
Apply KYC / ID VERIFICATION only (MLR 2017, FCA SYSC 6.3). Do NOT perform AML or income checks.
IMAGE QUALITY — check first:
- GLARE covering any text or photo = flag HIGH (re-upload required)
- Any corner cut off or not fully visible = flag HIGH (re-upload required)
- Blurry, too dark, unreadable = flag HIGH (re-upload required)
- If quality acceptable = PASS in rule_checks
DOCUMENT TYPE: Identify British passport, non-British passport, driving licence, or BRP.
BRITISH PASSPORT: Extract full name, DOB, passport number, nationality, expiry. Calculate months remaining from today (May 2026). Expired = HIGH. Under 3 months = HIGH (minimum validity). 3-6 months = MEDIUM. Over 6 months = PASS. Check MRZ visible and matches biographical page.
NON-BRITISH PASSPORT: Same expiry checks. Flag MEDIUM: UKVI share code required, verify at view.immigration.status.service.gov.uk, right to reside must be confirmed, check visa type permits mortgage.
BRP: Expiry HIGH if expired or under 3 months. Note visa/leave type. UKVI share code required regardless. Flag if visa type (student, temporary work) may restrict eligibility.
DRIVING LICENCE: Extract name, address, DOB, licence number, expiry. Note if address matches declared application address.
ALL DOCUMENTS: Prompt PEP check, HM Treasury sanctions check, OFAC sanctions check. Flag HIGH if name does not match client name provided.
Extract to key_data: full_name, date_of_birth, document_number, expiry_date, nationality, address (if present), issuing_country.`,

  proof_address: BASE + `
Apply PROOF OF ADDRESS checks only (MLR 2017 KYC). Do NOT perform AML transaction analysis.
Check: document type, full name, full address, date of document.
Flag HIGH if document is older than 3 months.
Confirm address matches declared application address if visible.
Do NOT flag any transactions, salary credits, or financial activity even if visible.
Extract to key_data: full_name, full_address, document_date, document_type.`,

  bank_statements: BASE + MULTI + `
Apply BANK STATEMENT ANALYSIS — AML (MLR 2017, JMLSG) and Income Matching (MCOB 11.6).
Extract to key_data: account_holder_name, account_number, sort_code, bank_name, statement_period, average_monthly_credits, salary_credits (list amounts and dates), total_regular_outgoings.
DEPOSIT TRAIL ANALYSIS:
- Check if deposit amount builds gradually over months (acceptable) vs sudden large unexplained lump sum (flag HIGH — source of funds required)
- Large single credit that could represent a gifted deposit = flag MEDIUM (gifted deposit letter and donor evidence required)
- If deposit came from property sale, inheritance, or bonus — flag that evidence of source is required
AML — flag every instance:
- Cash deposits over 1000 GBP = HIGH (MLR 2017 Reg 28)
- Multiple small cash deposits totalling over 3000 GBP/month = HIGH (structuring)
- Gambling (Bet365, Paddy Power, Sky Bet, Betfair, Ladbrokes, William Hill, Casumo, 888, PokerStars) = HIGH
- Payday loans (Wonga, Cashfloat, QuidMarket, Sunny, Lending Stream) = HIGH
- Round-number frequent transfers to unknown parties = MEDIUM (structuring)
- Unexplained overseas transfers = MEDIUM
- Crypto exchanges (Binance, Coinbase, Kraken) = MEDIUM
- Returned/unpaid direct debits = HIGH
- Unarranged overdraft = HIGH
- Account negative before salary = MEDIUM
- Second charge or secured loan payments (identify lender names) = flag MEDIUM (note amount)
INCOME MATCHING:
- Identify all salary credits — note amounts, dates, employer reference
- Check salary consistent month to month within 100 GBP
- Calculate average monthly net income
- Note ALL regular committed outgoings: loans, car finance, credit card minimums, child maintenance, rent/mortgage payments, school fees
EMPLOYMENT CONTINUITY (from bank credits):
- Check salary credits are present each month — flag HIGH if any month missing
- Note if salary payer reference changes (possible job change)`,

  payslips: BASE + MULTI + `
Apply PAYSLIP VERIFICATION (MCOB 11.6, HMRC).
Extract to key_data: employee_name, employer_name, pay_dates (list all), pay_periods (list all), gross_pay_each (list), net_pay_each (list), tax_code, ni_number, annual_gross_estimated, pension_deduction, student_loan_deduction.
TAX CODE ANALYSIS:
- 1257L or 1256L = PASS. S1257L = PASS (Scotland).
- M1 or W1 suffix = MEDIUM (emergency tax — new job or HMRC issue)
- BR = MEDIUM (basic rate all income)
- K code = HIGH (negative allowance — significant tax debt — must investigate)
- OT = MEDIUM (no personal allowance)
- D0 or D1 = MEDIUM (possible second job)
EMPLOYMENT CONTINUITY:
- Check pay dates are consecutive months — flag HIGH if any month is missing from the sequence
- Note employment start date if visible — flag MEDIUM if client appears to be in first 6 months (probation risk)
- Check if employer name is consistent across all payslips — flag MEDIUM if it changes
INCOME VERIFICATION:
- Gross pay x 12 vs declared annual income — flag MEDIUM if significantly different
- Variable pay (overtime/bonus/commission) — flag MEDIUM (only 50% typically accepted)
- Note student loan plan type if deducted (Plan 1 or Plan 2)`,

  p60_p45: BASE + MULTI + `
Apply P60 and P45 VERIFICATION (HMRC, MCOB 11.6).
A P45 is a VALID alternative to P60 for a year the client left employer — do NOT flag missing P60 if P45 covers that period.
Extract to key_data per document: document_type, tax_year, employee_name, employer_name, total_pay, total_tax, ni_number, ni_contributions, tax_code.
For P60: tax year, employee name, employer, total pay in year, total tax deducted, NI contributions, NI number, tax code at end of year.
For P45: leaving date, employer, total pay to leaving date, total tax to leaving date, tax code at leaving — flag MEDIUM if BR or emergency.
Compare year-on-year if multiple — flag MEDIUM if declining.
Flag if P60 annual total differs from payslip YTD gross by more than 500 GBP.
Flag HIGH if NI number differs between documents.
EMPLOYMENT GAP CHECK: If P45 leaving date and new employer first payslip date have a gap over 1 month — note the gap dates for cross-document review.`,

  sa302: BASE + MULTI + `
Apply SA302 and TAX YEAR OVERVIEW VERIFICATION (HMRC, MCOB 11.6).
Extract to key_data per document: document_type, tax_year, full_name, utr_number, net_profit, total_income, total_tax_due (SA302) or tax_charged (TYO).
For SA302: tax year, full name, UTR, net profit (NOT turnover), total income all sources, total tax due.
For Tax Year Overview: tax year, total tax charged, tax paid to date.
CRITICAL MATCH: Total tax due on SA302 MUST match tax charged on TYO for same year. Mismatch = HIGH flag (possible fraudulent document).
CONTRACTOR INCOME: If document suggests contractor income, note any day rate or contract references visible.
Year-on-year net profit — declining = MEDIUM. Under 2 years history = HIGH. Turnover declared instead of profit = HIGH.`,

  company_accounts: BASE + MULTI + `
Apply COMPANY ACCOUNTS VERIFICATION (Companies Act, MCOB 11.6).
Extract to key_data: company_name, company_registration_number, accounting_period, directors_listed, net_profit, turnover, retained_earnings, director_salary, dividends_paid, incorporation_date (if visible).
Check applicant is listed as director — prompt verify on Companies House.
Flag HIGH if net liabilities exceed net assets (insolvent).
Flag HIGH if dormant or dissolved status mentioned.
Flag HIGH if accounts suggest company incorporated less than 2 years ago (most lenders require 2 years trading).
Note outstanding loans or significant creditors.
LIMITED COMPANY BTL: If accounts suggest SPV structure for BTL — flag MEDIUM (different affordability rules apply for limited company BTL).
Prompt Companies House verification for active status, director listing, PSC register, filing history.`,

  credit_report: BASE + MULTI + `
Apply CREDIT REPORT ANALYSIS (standard lender underwriting criteria).
Extract to key_data: credit_score, bureau, report_date, total_accounts, active_defaults, ccjs, missed_payments_12m, total_outstanding_debt, monthly_committed_payments_estimated.
Check ALL of the following:
- CCJs: unsatisfied = HIGH. Satisfied within 3 years = MEDIUM.
- Defaults: within 3 years = HIGH. Satisfied within 3 years = MEDIUM. Note date, amount, creditor.
- Repossessions: any = HIGH.
- Missed payments on any credit product: 2+ in last 12 months = HIGH. 1 = MEDIUM.
- Arrangement to Pay markers: any = MEDIUM.
- High debt: monthly committed payments over 40% gross monthly income = HIGH.
- IVA active = HIGH. Bankruptcy = HIGH. DMP active = HIGH.
- Payday loan history: last 12 months = HIGH. 1-3 years ago = MEDIUM.
- Hard searches: 4+ in 6 months = MEDIUM. 6+ = HIGH.
- Electoral roll not registered = MEDIUM.
- Credit utilisation above 80% = HIGH. 50-80% = MEDIUM.
- Linked addresses: note all addresses shown — any undisclosed address = MEDIUM flag.
- Financial associations: note any associated individuals — adverse credit associations = MEDIUM.
- Existing mortgage on report: note lender, balance, monthly payment, payment history.
- Closed accounts with missed payments: flag LOW (historic adverse).
- Note overall credit score and bureau.`,

  gift_letter: BASE + `
Apply GIFTED DEPOSIT VERIFICATION (MLR 2017, AML, standard lender requirements).
This slot may contain a gift letter, donor proof of ID, or donor bank statement — identify which.
FOR GIFT LETTER:
- Confirm it states the gift is non-repayable (a repayable gift = loan = HIGH flag — affects affordability)
- Extract: donor name, donor relationship to applicant, gift amount, confirmation non-repayable, donor signature, date
- Flag HIGH if letter states or implies repayment is expected
- Flag MEDIUM if donor relationship is not immediate family (some lenders restrict to immediate family only)
- Check gift amount matches deposit amount declared on application
FOR DONOR PROOF OF ID:
- Apply same ID checks as main applicant ID (expiry, quality, name match)
FOR DONOR BANK STATEMENT:
- Confirm the gift amount was present in donor account prior to transfer (donor must demonstrably have the funds)
- Flag HIGH if gift amount not evidenced in donor account
- Flag HIGH if donor appears to have borrowed the gift amount themselves (loan credit shortly before the gift transfer)
- Check donor account shows the transfer out matching the gift amount`,
};

const getPrompt = (docId) => PROMPTS[docId] || BASE;

// ── Cross-document matching engine ────────────────────────────────────────────

function runCrossDocumentChecks(results, clientDetails, propertyDetails, expenditure) {
  const flags = [];
  const checks = [];

  const getKeyData = (docId) => {
    const slots = results[docId] || [];
    return slots.filter(s => s.result?.key_data).map(s => s.result.key_data);
  };

  const idData = getKeyData("id_doc")[0] || {};
  const poaData = getKeyData("proof_address")[0] || {};
  const bsData = getKeyData("bank_statements");
  const payData = getKeyData("payslips");
  const p60Data = getKeyData("p60_p45");
  const sa302Data = getKeyData("sa302");

  const clientName = clientDetails.name?.toLowerCase().trim();

  // ── Name consistency ──────────────────────────────────────────────────────
  const idName = idData.full_name?.toLowerCase().trim();
  const poaName = poaData.full_name?.toLowerCase().trim();
  const payNames = payData.map(d => (d.employee_name || d.doc_1_employee_name || "").toLowerCase().trim()).filter(Boolean);
  const p60Names = p60Data.map(d => (d.employee_name || d.doc_1_employee_name || "").toLowerCase().trim()).filter(Boolean);

  if (idName && poaName && !poaName.includes(idName.split(" ")[0])) {
    flags.push({ severity:"HIGH", rule_ref:"MLR 2017 KYC", message:`Name mismatch: ID shows "${idData.full_name}" but Proof of Address shows "${poaData.full_name}"` });
  }
  payNames.forEach(n => {
    if (idName && n && !n.includes(idName.split(" ")[0])) {
      flags.push({ severity:"HIGH", rule_ref:"MLR 2017 / MCOB 11.6", message:`Name mismatch: ID shows "${idData.full_name}" but payslip shows "${n}"` });
    }
  });
  p60Names.forEach(n => {
    if (idName && n && !n.includes(idName.split(" ")[0])) {
      flags.push({ severity:"HIGH", rule_ref:"MLR 2017 / HMRC", message:`Name mismatch: ID shows "${idData.full_name}" but P60/P45 shows "${n}"` });
    }
  });
  if (idName) checks.push({ rule:"KYC Name Consistency", check:"Name on ID vs all documents", result: flags.filter(f=>f.message.includes("Name mismatch")).length===0?"PASS":"FAIL", detail: flags.filter(f=>f.message.includes("Name mismatch")).length===0?"All names consistent":"Mismatches found — see flags" });

  // ── Address consistency ───────────────────────────────────────────────────
  const idAddr = (idData.address || "").toLowerCase();
  const poaAddr = (poaData.full_address || "").toLowerCase();
  if (idAddr && poaAddr && !idAddr.includes(poaAddr.split(",")[0]?.trim()) && !poaAddr.includes(idAddr.split(",")[0]?.trim())) {
    flags.push({ severity:"MEDIUM", rule_ref:"MLR 2017 KYC", message:`Address mismatch: driving licence shows different address to proof of address — verify with client` });
  }
  checks.push({ rule:"KYC Address Consistency", check:"Address on ID vs Proof of Address", result: idAddr&&poaAddr?"PASS":"N/A", detail:"Cross-check performed where data available" });

  // ── Salary cross-matching ─────────────────────────────────────────────────
  const payNetAmounts = payData.map(d => parseFloat(d.net_pay_each || d.doc_1_net_pay || 0)).filter(n => n > 0);
  const bsAvgCredits = bsData.map(d => parseFloat(d.average_monthly_credits || 0)).filter(n => n > 0);

  if (payNetAmounts.length > 0 && bsAvgCredits.length > 0) {
    const avgPay = payNetAmounts.reduce((a,b)=>a+b,0)/payNetAmounts.length;
    const avgCredit = bsAvgCredits.reduce((a,b)=>a+b,0)/bsAvgCredits.length;
    if (Math.abs(avgPay - avgCredit) > 200) {
      flags.push({ severity:"MEDIUM", rule_ref:"MCOB 11.6", message:`Salary mismatch: Average net pay on payslips (£${Math.round(avgPay).toLocaleString()}) does not closely match average bank credits (£${Math.round(avgCredit).toLocaleString()}) — verify salary account is the one provided` });
    } else {
      checks.push({ rule:"MCOB 11.6 Salary Match", check:"Net pay on payslips vs bank statement credits", result:"PASS", detail:`Payslip net pay ~£${Math.round(avgPay).toLocaleString()} matches bank credits ~£${Math.round(avgCredit).toLocaleString()}` });
    }
  }

  // ── NI number consistency ─────────────────────────────────────────────────
  const payNI = payData.map(d => (d.ni_number||"").replace(/\s/g,"").toUpperCase()).filter(Boolean);
  const p60NI = p60Data.map(d => (d.ni_number||d.doc_1_ni_number||"").replace(/\s/g,"").toUpperCase()).filter(Boolean);
  const allNI = [...new Set([...payNI, ...p60NI])];
  if (allNI.length > 1) {
    flags.push({ severity:"HIGH", rule_ref:"HMRC / MLR 2017", message:`NI number inconsistency across documents: found ${allNI.join(" and ")} — verify correct NI number with client` });
  } else if (allNI.length === 1) {
    checks.push({ rule:"HMRC NI Consistency", check:"NI number across payslips and P60/P45", result:"PASS", detail:`Consistent NI number: ${allNI[0]}` });
  }

  // ── P60 vs Payslip annual income ──────────────────────────────────────────
  const p60Pay = p60Data.map(d => parseFloat(d.total_pay||d.doc_1_total_pay||0)).filter(n=>n>0);
  const payGross = payData.map(d => parseFloat(d.annual_gross_estimated||d.doc_1_annual_gross_estimated||0)).filter(n=>n>0);
  if (p60Pay.length>0 && payGross.length>0) {
    const diff = Math.abs(p60Pay[0] - payGross[0]);
    if (diff > 500) {
      flags.push({ severity:"MEDIUM", rule_ref:"HMRC / MCOB 11.6", message:`P60 total pay (£${p60Pay[0].toLocaleString()}) differs from payslip annualised gross (£${payGross[0].toLocaleString()}) by £${diff.toLocaleString()} — exceeds £500 tolerance` });
    } else {
      checks.push({ rule:"HMRC P60 vs Payslip", check:"P60 annual pay vs payslip annualised gross", result:"PASS", detail:`Within £500 tolerance` });
    }
  }

  // ── Retirement age check ──────────────────────────────────────────────────
  const dob = idData.date_of_birth || idData.dob;
  const termYears = parseFloat(propertyDetails.mortgageTerm || 25);
  if (dob) {
    try {
      const dobDate = new Date(dob.replace(/(\d{2})\/(\d{2})\/(\d{4})/,"$3-$2-$1"));
      const ageNow = Math.floor((new Date() - dobDate) / (365.25*24*60*60*1000));
      const ageAtEnd = ageNow + termYears;
      if (ageAtEnd > 75) {
        flags.push({ severity:"HIGH", rule_ref:"Lender Age Policy", message:`Client will be ${Math.round(ageAtEnd)} at end of mortgage term — most lenders cap at age 70-75. Term may need reducing or specialist lender required` });
      } else if (ageAtEnd > 70) {
        flags.push({ severity:"MEDIUM", rule_ref:"Lender Age Policy", message:`Client will be ${Math.round(ageAtEnd)} at end of mortgage term — some lenders cap at 70. Verify lender age policy` });
      } else {
        checks.push({ rule:"Lender Age Policy", check:"Age at end of mortgage term", result:"PASS", detail:`Client age at end of term: ${Math.round(ageAtEnd)}` });
      }
    } catch(e) {}
  }

  // ── Enhanced due diligence trigger ────────────────────────────────────────
  const propertyVal = parseFloat(clientDetails.propertyValue || 0);
  if (propertyVal >= 500000) {
    flags.push({ severity:"MEDIUM", rule_ref:"MLR 2017 Enhanced DD", message:`Property value £${propertyVal.toLocaleString()} triggers enhanced due diligence threshold — source of wealth declaration required (not just source of deposit funds)` });
  }

  // ── Affordability full stress test ────────────────────────────────────────
  const income = parseFloat(clientDetails.income || 0);
  const monthlyNet = income > 0 ? Math.round((income * 0.75) / 12) : 0;
  const totalCommitted = Object.values(expenditure).reduce((a,b)=>a+(parseFloat(b)||0),0);
  const loan = parseFloat(clientDetails.propertyValue||0) - parseFloat(clientDetails.deposit||0);
  if (loan > 0 && income > 0 && totalCommitted > 0) {
    const smr = 6/100/12; const n = (parseFloat(propertyDetails.mortgageTerm||25))*12;
    const stressPayment = Math.round(loan*(smr*Math.pow(1+smr,n))/(Math.pow(1+smr,n)-1));
    const disposable = monthlyNet - totalCommitted - stressPayment;
    if (disposable < 0) {
      flags.push({ severity:"HIGH", rule_ref:"MCOB 11.6.5", message:`AFFORDABILITY FAIL at stress rate: Net monthly income ~£${monthlyNet.toLocaleString()} minus committed outgoings £${totalCommitted.toLocaleString()} minus stressed mortgage payment £${stressPayment.toLocaleString()} = £${disposable.toLocaleString()} (negative — MCOB 11.6.5 breach)` });
    } else {
      checks.push({ rule:"MCOB 11.6.5 Stress Test", check:"Full affordability after committed expenditure at 6% stress rate", result:"PASS", detail:`Disposable income after all commitments and stressed mortgage: £${disposable.toLocaleString()}/month` });
    }
  }

  // ── Protection needs reminder ─────────────────────────────────────────────
  flags.push({ severity:"LOW", rule_ref:"FCA MCOB 4", message:`Reminder: Protection needs must be assessed for this regulated mortgage — life insurance, critical illness, and income protection adequacy should be discussed with client` });

  return { flags, checks };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(",")[1]);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

function dl(text, name, mime) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name; a.click();
}

function tryJSON(raw) {
  const str = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!str) return null;
  try { return JSON.parse(str); } catch {}
  let s = str.replace(/,\s*$/, "");
  let ob=0,ob2=0,ins=false,esc=false;
  for (const ch of s) {
    if(esc){esc=false;continue;} if(ch==="\\"){esc=true;continue;}
    if(ch==='"'){ins=!ins;continue;} if(ins)continue;
    if(ch==="{")ob++;else if(ch==="}")ob--;
    if(ch==="[")ob2++;else if(ch==="]")ob2--;
  }
  for(let i=0;i<ob2;i++)s+="]"; for(let i=0;i<ob;i++)s+="}";
  try { return JSON.parse(s); } catch {}
  return { document_type:"Unknown", key_data:{}, rule_checks:[], flags:[{severity:"MEDIUM",rule_ref:"SYSTEM",message:"Response truncated — re-upload for full analysis."}], summary:"Partial only.", passed:false };
}

async function callAPI(body, label, setStatus) {
  let attempts = 0;
  while (attempts < 3) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)
    });
    if (res.status === 429) {
      attempts++;
      const wait = attempts * 10000;
      if(setStatus) setStatus(`Rate limited — waiting ${wait/1000}s before retry ${attempts}/3 for ${label}...`);
      await new Promise(r=>setTimeout(r,wait));
      continue;
    }
    if (!res.ok) { const t=await res.text(); throw new Error(`API ${res.status}: ${t.slice(0,150)}`); }
    const d = await res.json();
    if (d.error) throw new Error(d.error.message||JSON.stringify(d.error));
    return d.content?.map(i=>i.text||"").join("")||"";
  }
  throw new Error("Rate limit reached after 3 retries. Please wait a few minutes.");
}

async function companiesHouseCheck(regNumber) {
  if (!regNumber) return null;
  const clean = regNumber.replace(/\s/g,"").toUpperCase();
  // Use Claude AI to look up Companies House data (avoids CORS in browser)
  const prompt = `Search Companies House for UK company number ${clean}. Search for "companies house ${clean} company overview" and also try fetching https://find-and-update.company-information.service.gov.uk/company/${clean} to get the full company profile.

Extract every field visible on the company overview page. Return ONLY valid JSON:
{
  "company_name": "string",
  "company_number": "${clean}",
  "company_status": "active or dissolved or liquidation or struck-off or dormant",
  "date_of_creation": "YYYY-MM-DD",
  "type": "Private limited company or LLP or PLC etc",
  "registered_office_address": "full address as shown",
  "nature_of_business": "SIC code and description if visible",
  "accounts_next_due": "DD MMM YYYY or null",
  "accounts_last_made_up": "DD MMM YYYY or null",
  "confirmation_statement_next_due": "DD MMM YYYY or null",
  "confirmation_statement_last_made_up": "DD MMM YYYY or null",
  "confirmation_statement_overdue": true or false,
  "accounts_overdue": true or false,
  "has_insolvency_history": true or false,
  "directors_note": "Could not retrieve — check https://find-and-update.company-information.service.gov.uk/company/${clean}/officers",
  "error": null
}
If company not found set error field. Return JSON only, no prose, no markdown fences.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: prompt }]
      })
    });
    if (!res.ok) {
      const t = await res.text();
      return { error: `API error ${res.status}: ${t.slice(0,100)}` };
    }
    const d = await res.json();
    // Extract text from response — may have tool_use blocks before final text
    const textBlocks = (d.content||[]).filter(b => b.type === "text");
    const raw = textBlocks.map(b => b.text).join("");
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return { error: "Could not parse Companies House response" };
    return JSON.parse(match[0]);
  } catch(e) {
    return { error: e.message };
  }
}

function exportCSV(scenarios, cd, report) {
  const rows = [
    ["MORTGAGE COMPLIANCE REPORT"],["Client",cd.name||"N/A"],
    ["Income","GBP"+cd.income],["Property","GBP"+cd.propertyValue],["Deposit","GBP"+cd.deposit],
    ["Recommendation",report?.recommendation||"N/A"],[""],
    ["Product","Loan","Rate","Term","Monthly","Stress@6%","LTV","Total"],
    ...(scenarios||[]).map(s=>[s.label,s.loan,s.rate+"%",s.term+"yr","GBP"+s.monthly,"GBP"+s.stressMonthly,s.ltv+"%","GBP"+s.total]),
  ];
  dl(rows.map(r=>r.join(",")).join("\n"),`mortgage-${Date.now()}.csv`,"text/csv");
}

function exportJSON(data) { dl(JSON.stringify(data,null,2),`mortgage-session-${Date.now()}.json`,"application/json"); }

function downloadReport(cd, pd, exp, results, report, mType, chData) {
  const rc=report?.recommendation==="PROCEED"?"#10b981":report?.recommendation==="DECLINE"?"#ef4444":"#f59e0b";
  const date=new Date().toLocaleDateString("en-GB",{day:"2-digit",month:"long",year:"numeric"});
  const allFlags=Object.values(results).flatMap(s=>s||[]).flatMap(s=>s.result?.flags||[]);
  const crossFlags=report?.crossFlags||[];
  const allFlagsIncCross=[...allFlags,...crossFlags];

  const docRows=DOC_TYPES.map(d=>{
    const slots=(results[d.id]||[]).filter(s=>s.result);
    if(!slots.length)return `<tr><td>${d.label}</td><td style="color:#94a3b8">Not uploaded</td><td>-</td></tr>`;
    const flags=slots.flatMap(s=>s.result.flags||[]);
    const hf=flags.filter(f=>f.severity==="HIGH").length;
    const mf=flags.filter(f=>f.severity==="MEDIUM").length;
    const sc=hf?"#ef4444":mf?"#f59e0b":"#10b981";
    const st=hf?"HIGH RISK":mf?"REVIEW":"CLEAR";
    const fl=flags.map(f=>`<span style="color:${f.severity==="HIGH"?"#ef4444":f.severity==="MEDIUM"?"#f59e0b":"#94a3b8"};font-weight:600">[${f.severity}]</span> <em style="font-size:10px;color:#64748b">${f.rule_ref||""}</em> ${f.message}`).join("<br>");
    return `<tr><td><strong>${d.icon} ${d.label}</strong><br><span style="font-size:10px;color:#94a3b8">${slots.length} file${slots.length>1?"s":""}</span></td><td style="color:${sc};font-weight:700">${st}</td><td style="font-size:11px">${fl||"<span style='color:#10b981'>No issues</span>"}</td></tr>`;
  }).join("");

  const highRows=allFlagsIncCross.filter(f=>f.severity==="HIGH").map(f=>`<tr><td style="color:#ef4444;font-weight:800">HIGH</td><td style="color:#64748b;font-size:10px">${f.rule_ref||"—"}</td><td>${f.message}</td></tr>`).join("");
  const medRows=allFlagsIncCross.filter(f=>f.severity==="MEDIUM").map(f=>`<tr><td style="color:#f59e0b;font-weight:800">MEDIUM</td><td style="color:#64748b;font-size:10px">${f.rule_ref||"—"}</td><td>${f.message}</td></tr>`).join("");
  const scRows=(report?.scenarios||[]).map((s,i)=>`<tr style="background:${i%2===0?"#f8fafc":"#fff"}"><td style="color:#64748b">${s.label}</td><td><strong>£${(s.loan||0).toLocaleString()}</strong></td><td style="color:#f59e0b">${s.rate}%</td><td style="color:#64748b">${s.term}yr</td><td><strong>£${(s.monthly||0).toLocaleString()}</strong></td><td style="color:#f59e0b">£${(s.stressMonthly||0).toLocaleString()}</td><td>${s.ltv}%</td><td style="color:#64748b">£${(s.total||0).toLocaleString()}</td></tr>`).join("");
  const pills=[{label:"Affordability",val:report?.affordability_verdict||"—",ok:report?.affordability_verdict==="PASS"},{label:"AML",val:report?.aml_verdict||"—",ok:report?.aml_verdict==="CLEAR"},{label:"KYC",val:report?.kyc_verdict||"—",ok:report?.kyc_verdict==="PASS"},{label:"Cross-Doc",val:crossFlags.filter(f=>f.severity==="HIGH").length>0?"ISSUES":"PASS",ok:crossFlags.filter(f=>f.severity==="HIGH").length===0}].map(v=>`<div style="background:#f8fafc;border-radius:8px;padding:10px 16px;border:1px solid ${v.ok?"#10b981":"#ef4444"}40;text-align:center"><div style="font-size:9px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px">${v.label}</div><div style="font-size:13px;font-weight:800;color:${v.ok?"#10b981":"#ef4444"}">${v.val}</div></div>`).join("");

  const totalCommitted=Object.values(exp).reduce((a,b)=>a+(parseFloat(b)||0),0);
  const chSection=chData?`<div class="sec">Companies House Verification</div><div style="background:#f8fafc;border-radius:8px;padding:12px;font-size:12px">${chData.error?`<span style="color:#ef4444">Error: ${chData.error}</span>`:`<strong>${chData.company_name||"N/A"}</strong> · Reg: ${chData.company_number||"N/A"} · Status: <strong style="color:${chData.company_status==="active"?"#10b981":"#ef4444"}">${(chData.company_status||"unknown").toUpperCase()}</strong> · Incorporated: ${chData.date_of_creation||"N/A"} · Type: ${chData.type||"N/A"}`}</div>`:"";

  const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Mortgage Report - ${cd.name||"Client"}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',Arial,sans-serif;color:#1e293b;font-size:12px;line-height:1.5;background:#fff}.page{padding:32px 36px;max-width:960px;margin:0 auto}.hdr{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:22px;padding-bottom:18px;border-bottom:3px solid #0ea5e9}.title{font-size:20px;font-weight:800;color:#0f172a;margin-bottom:4px}.sub{font-size:10px;color:#64748b;line-height:1.7}.badge{padding:8px 18px;border-radius:8px;font-weight:800;font-size:14px;border:2px solid ${rc};color:${rc};background:${rc}18;white-space:nowrap}.sec{font-size:10px;font-weight:800;letter-spacing:1.5px;color:#64748b;text-transform:uppercase;margin:22px 0 8px;padding-bottom:5px;border-bottom:2px solid #f1f5f9}.g3{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:8px}.g4{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:8px}.stat{background:#f8fafc;border-radius:7px;padding:10px 12px;border:1px solid #e2e8f0}.sl{font-size:9px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px}.sv{font-size:17px;font-weight:800;color:#0f172a}.pills{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px}.sumbox{background:#f8fafc;border-radius:8px;padding:14px;border-left:4px solid ${rc};line-height:1.8;font-size:12px}.rbox{padding:9px 13px;border-radius:6px;border-left:4px solid ${rc};background:${rc}0d;margin-bottom:14px;font-size:12px}.ibox{background:#f8fafc;border-radius:7px;padding:11px 13px;margin-bottom:6px;font-size:12px}.kp{display:flex;gap:8px;padding:6px 0;border-bottom:1px solid #f1f5f9;font-size:12px}.kpn{color:#0ea5e9;font-weight:800;min-width:18px}.nt{padding:5px 0;border-bottom:1px solid #f1f5f9;color:#475569;font-size:11px}table{width:100%;border-collapse:collapse;font-size:11px}th{background:#f1f5f9;padding:7px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:#64748b;border-bottom:2px solid #e2e8f0}td{padding:7px 10px;border-bottom:1px solid #f8fafc;vertical-align:top}.footer{margin-top:28px;padding-top:10px;border-top:1px solid #e2e8f0;font-size:10px;color:#94a3b8;line-height:1.7}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}.noprint{display:none}}@page{margin:12mm;size:A4}</style>
</head><body><div class="page">
<div class="hdr"><div><div class="title">Mortgage Compliance &amp; Affordability Report</div><div class="sub">Client: <strong>${cd.name||"N/A"}</strong> | Date: ${date} | Type: <strong>${mType.toUpperCase()}</strong><br>Rules: FCA MCOB 11.6 &amp; 11.6.5 · AML/MLR 2017 · KYC/JMLSG · Cross-Document Matching · UK GDPR/DPA 2018</div></div><div class="badge">${report?.recommendation==="PROCEED"?"PROCEED":report?.recommendation==="DECLINE"?"DECLINE":"REFER TO ADVISOR"}</div></div>
<div class="sec">Case Details</div>
<div class="g3"><div class="stat"><div class="sl">Annual Income</div><div class="sv">£${parseFloat(cd.income||0).toLocaleString()}</div></div><div class="stat"><div class="sl">Property Value</div><div class="sv">£${parseFloat(cd.propertyValue||0).toLocaleString()}</div></div><div class="stat"><div class="sl">Deposit</div><div class="sv">£${parseFloat(cd.deposit||0).toLocaleString()}</div></div><div class="stat"><div class="sl">Loan Amount</div><div class="sv">£${(parseFloat(cd.propertyValue||0)-parseFloat(cd.deposit||0)).toLocaleString()}</div></div><div class="stat"><div class="sl">LTV</div><div class="sv" style="color:${report?.ltv>85?"#ef4444":report?.ltv>75?"#f59e0b":"#10b981"}">${report?.ltv||0}%</div></div><div class="stat"><div class="sl">Max Borrow 4.5x</div><div class="sv">£${Math.round(parseFloat(cd.income||0)*4.5).toLocaleString()}</div></div></div>
${totalCommitted>0?`<div class="g4"><div class="stat"><div class="sl">Monthly Committed</div><div class="sv" style="color:#ef4444">£${totalCommitted.toLocaleString()}</div></div><div class="stat"><div class="sl">Property Type</div><div class="sv" style="font-size:13px">${pd.propertyType||"N/A"}</div></div><div class="stat"><div class="sl">Tenure</div><div class="sv" style="font-size:13px">${pd.tenure||"N/A"}</div></div><div class="stat"><div class="sl">Mortgage Term</div><div class="sv">${pd.mortgageTerm||25}yr</div></div></div>`:""}
<div class="sec">Compliance Verdicts</div>
${report?.recommendation_reason?`<div class="rbox">${report.recommendation_reason}</div>`:""}
<div class="pills">${pills}</div>
<div class="sec">Underwriter Summary</div><div class="sumbox">${report?.summary||"No summary generated."}</div>
${report?.affordability_detail?`<div class="sec">Affordability Detail</div><div class="ibox">${report.affordability_detail}</div>`:""}
${report?.key_points?.length?`<div class="sec">Key Points for Advisor</div>${report.key_points.map((p,i)=>`<div class="kp"><span class="kpn">${i+1}.</span><span>${p}</span></div>`).join("")}`:""}
${report?.lender_suitability?`<div class="sec">Lender Suitability</div><div class="ibox">${report.lender_suitability}</div>`:""}
${chSection}
<div class="sec">Document Analysis</div><table><thead><tr><th>Document</th><th>Status</th><th>Flags</th></tr></thead><tbody>${docRows}</tbody></table>
${crossFlags.length?`<div class="sec" style="color:#0ea5e9">Cross-Document Matching Results</div><table><thead><tr><th>Severity</th><th>Rule</th><th>Finding</th></tr></thead><tbody>${crossFlags.map(f=>`<tr><td style="color:${f.severity==="HIGH"?"#ef4444":"#f59e0b"};font-weight:800">${f.severity}</td><td style="font-size:10px;color:#64748b">${f.rule_ref||"—"}</td><td>${f.message}</td></tr>`).join("")}</tbody></table>`:""}
${highRows?`<div class="sec" style="color:#ef4444">High Risk Flags</div><table><thead><tr><th>Severity</th><th>Rule Ref</th><th>Finding</th></tr></thead><tbody>${highRows}</tbody></table>`:`<div class="sec">High Risk Flags</div><div style="padding:9px 12px;background:#f0fdf4;border-radius:6px;color:#10b981">No high risk flags identified</div>`}
${medRows?`<div class="sec" style="color:#f59e0b">Medium Risk Flags</div><table><thead><tr><th>Severity</th><th>Rule Ref</th><th>Finding</th></tr></thead><tbody>${medRows}</tbody></table>`:""}
${scRows?`<div class="sec">Repayment Scenarios + MCOB 11.6.5 Stress Test</div><table><thead><tr><th>Product</th><th>Loan</th><th>Rate</th><th>Term</th><th>Monthly</th><th>Stress @6%</th><th>LTV</th><th>Total</th></tr></thead><tbody>${scRows}</tbody></table><div style="font-size:10px;color:#94a3b8;margin-top:5px">Stress rate 6% per MCOB 11.6.5. Illustrative only.</div>`:""}
<div class="footer"><strong>DISCLAIMER:</strong> AI-generated for administrative purposes only. Not regulated financial advice under FSMA 2000. All findings must be verified by a qualified FCA-authorised mortgage advisor. Confidential — contains personal financial data. · EDGE Mortgage AI Assistant · ${date}</div>
</div></body></html>`;

  const blob=new Blob([html],{type:"text/html"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url;
  a.download=`Mortgage-Report-${(cd.name||"Client").replace(/\s+/g,"-")}-${new Date().toISOString().slice(0,10)}.html`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ── UI Components ─────────────────────────────────────────────────────────────

function Pill({label,value,ok,warn}) {
  const col=ok?C.success:warn?C.warning:C.danger;
  return <div style={{background:C.card,borderRadius:8,padding:"6px 14px",border:`1px solid ${col}50`}}><div style={{color:C.muted,fontSize:9,letterSpacing:1}}>{label}</div><div style={{color:col,fontSize:12,fontWeight:800}}>{value||"—"}</div></div>;
}

function Input({label,value,onChange,type="text",placeholder=""}) {
  const [local, setLocal] = useState(value);
  // Sync if parent value changes externally (e.g. session load)
  const prevValue = useRef(value);
  if (prevValue.current !== value && local !== value) {
    prevValue.current = value;
    setLocal(value);
  }
  return <div><div style={{color:C.muted,fontSize:10,marginBottom:3}}>{label}</div><input
    type={type}
    placeholder={placeholder}
    value={local}
    onChange={e=>setLocal(e.target.value)}
    onBlur={()=>onChange(local)}
    style={{width:"100%",background:C.card,border:`1px solid ${C.border}`,borderRadius:7,padding:"7px 11px",color:C.text,fontFamily:"inherit",fontSize:13,outline:"none"}}
  /></div>;
}

function FileSlot({slot,onRemove}) {
  const [open,setOpen]=useState(false);
  const r=slot.result;
  const hf=r?.flags?.filter(f=>f.severity==="HIGH").length||0;
  const mf=r?.flags?.filter(f=>f.severity==="MEDIUM").length||0;
  const sc=!r?C.muted:hf?C.danger:mf?C.warning:C.success;
  const st=!r?(slot.loading?"Analysing...":"Queued"):hf?`${hf} HIGH`:mf?"REVIEW":"CLEAR";
  return <div style={{background:C.bg,borderRadius:7,padding:"8px 10px",marginBottom:5,border:`1px solid ${C.border}`}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
      <div style={{display:"flex",gap:6,alignItems:"center",flex:1,minWidth:0}}>
        <span style={{fontSize:10}}>📄</span>
        <span style={{color:C.text,fontSize:11,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{slot.fileName}</span>
      </div>
      <div style={{display:"flex",gap:6,alignItems:"center",flexShrink:0}}>
        <span style={{color:sc,fontSize:10,fontWeight:700}}>{st}</span>
        {r&&<button onClick={()=>setOpen(!open)} style={{background:"transparent",border:`1px solid ${C.border}`,color:C.muted,borderRadius:4,padding:"1px 6px",fontSize:9,cursor:"pointer"}}>{open?"▲":"▼"}</button>}
        <button onClick={onRemove} style={{background:"transparent",border:"none",color:C.muted,cursor:"pointer",fontSize:12,padding:"0 2px"}}>✕</button>
      </div>
    </div>
    {open&&r&&<div style={{marginTop:8}}>
      {r.key_data&&Object.keys(r.key_data).length>0&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:3,marginBottom:6}}>
        {Object.entries(r.key_data).slice(0,6).map(([k,v])=><div key={k} style={{background:C.card,borderRadius:4,padding:"3px 6px"}}><div style={{color:C.muted,fontSize:9}}>{k.replace(/_/g," ").toUpperCase()}</div><div style={{color:C.text,fontSize:10,fontWeight:600}}>{String(v).slice(0,30)}</div></div>)}
      </div>}
      {r.flags?.map((f,i)=><div key={i} style={{display:"flex",gap:6,padding:"3px 0",borderTop:`1px solid ${C.border}`}}>
        <span style={{color:f.severity==="HIGH"?C.danger:f.severity==="MEDIUM"?C.warning:C.muted,fontSize:9,fontWeight:800,minWidth:42,flexShrink:0}}>{f.severity}</span>
        <div style={{fontSize:10}}>{f.rule_ref&&<span style={{color:C.accent}}>{f.rule_ref} · </span>}<span style={{color:C.text}}>{f.message}</span></div>
      </div>)}
      {r.summary&&<div style={{marginTop:5,color:C.muted,fontSize:10,fontStyle:"italic"}}>{r.summary}</div>}
    </div>}
  </div>;
}

function DocCard({doc,slots,onUpload,onRemove}) {
  const ref=useRef();
  const [drag,setDrag]=useState(false);
  const canAdd=slots.length<doc.maxFiles;
  const allFlags=slots.flatMap(s=>s.result?.flags||[]);
  const hf=allFlags.filter(f=>f.severity==="HIGH").length;
  const mf=allFlags.filter(f=>f.severity==="MEDIUM").length;
  const bc=slots.length===0?(drag?C.accent:C.border):hf?C.danger+"70":mf?C.warning+"70":C.success+"70";
  return <div style={{background:C.card,border:`1px solid ${bc}`,borderRadius:12,padding:14,transition:"border-color 0.2s"}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
      <div style={{display:"flex",gap:8,alignItems:"center"}}>
        <span style={{fontSize:20}}>{doc.icon}</span>
        <div>
          <div style={{color:C.text,fontWeight:700,fontSize:13}}>{doc.label}</div>
          <div style={{color:C.muted,fontSize:10,marginTop:1}}>{doc.desc}</div>
          {doc.multi&&<div style={{display:"flex",gap:6,marginTop:3}}>
            <span style={{fontSize:9,color:C.muted}}>{slots.length}/{doc.maxFiles} uploaded</span>
            {slots.length<doc.minSuggested&&<span style={{fontSize:9,color:C.warning,fontWeight:700}}>suggest {doc.minSuggested} min</span>}
            <span style={{fontSize:9,color:C.muted}}>· optional</span>
          </div>}
        </div>
      </div>
      {slots.length>0&&(hf>0?<span style={{color:C.danger,fontSize:11,fontWeight:700}}>⚠ {hf} HIGH</span>:mf>0?<span style={{color:C.warning,fontSize:11,fontWeight:700}}>! REVIEW</span>:<span style={{color:C.success,fontSize:11,fontWeight:700}}>✓ CLEAR</span>)}
    </div>
    {canAdd&&<div onDragOver={e=>{e.preventDefault();setDrag(true);}} onDragLeave={()=>setDrag(false)} onDrop={e=>{e.preventDefault();setDrag(false);Array.from(e.dataTransfer.files).forEach(f=>onUpload(doc.id,f));}} onClick={()=>ref.current.click()} style={{border:`2px dashed ${drag?C.accent:C.subtle}`,borderRadius:8,padding:"10px",textAlign:"center",cursor:"pointer",background:drag?C.accent+"10":"transparent",marginBottom:slots.length?10:0}}>
      <div style={{color:C.muted,fontSize:11}}>{doc.multi&&slots.length>0?"+ Add another document":"Drop file or click to upload"}</div>
      <div style={{color:C.muted,fontSize:9,marginTop:2}}>PDF, JPG, PNG{doc.multi&&` · ${slots.length}/${doc.maxFiles}`}</div>
      <input ref={ref} type="file" accept=".pdf,image/*" multiple={doc.multi} style={{display:"none"}} onChange={e=>{Array.from(e.target.files).forEach(f=>onUpload(doc.id,f));e.target.value="";}}/>
    </div>}
    {slots.map((slot,i)=><FileSlot key={i} slot={slot} onRemove={()=>onRemove(doc.id,i)}/>)}
  </div>;
}

function ScenarioTable({scenarios}) {
  if(!scenarios?.length)return null;
  return <div style={{overflowX:"auto"}}>
    <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
      <thead><tr style={{borderBottom:`2px solid ${C.accent}`}}>
        {["Product","Loan","Rate","Term","Monthly","Stress@6%","LTV","Total"].map(h=><th key={h} style={{padding:"7px 10px",color:C.accent,fontWeight:700,textAlign:"left",fontSize:10}}>{h}</th>)}
      </tr></thead>
      <tbody>{scenarios.map((s,i)=><tr key={i} style={{borderBottom:`1px solid ${C.border}`,background:i%2===0?C.card:"transparent"}}>
        <td style={{padding:"7px 10px",color:C.muted,fontSize:11}}>{s.label}</td>
        <td style={{padding:"7px 10px",color:C.text,fontWeight:600}}>£{(s.loan||0).toLocaleString()}</td>
        <td style={{padding:"7px 10px",color:C.gold}}>{s.rate}%</td>
        <td style={{padding:"7px 10px",color:C.muted}}>{s.term}yr</td>
        <td style={{padding:"7px 10px",color:C.text,fontWeight:700}}>£{(s.monthly||0).toLocaleString()}</td>
        <td style={{padding:"7px 10px",color:C.warning}}>£{(s.stressMonthly||0).toLocaleString()}</td>
        <td style={{padding:"7px 10px",color:s.ltv>85?C.danger:s.ltv>75?C.warning:C.success}}>{s.ltv}%</td>
        <td style={{padding:"7px 10px",color:C.muted}}>£{(s.total||0).toLocaleString()}</td>
      </tr>)}</tbody>
    </table>
    <div style={{color:C.muted,fontSize:9,marginTop:5}}>Stress rate 6% per MCOB 11.6.5. Illustrative only.</div>
  </div>;
}

// ── Main App ──────────────────────────────────────────────────────────────────

function PanelToggle({label,open,toggle,children}) {
  return <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:12,padding:14,marginBottom:14}}>
    <div onClick={toggle} style={{display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}}>
      <div style={{color:C.muted,fontSize:10,fontWeight:700,letterSpacing:1}}>{label}</div>
      <span style={{color:C.muted,fontSize:12}}>{open?"▲":"▼"}</span>
    </div>
    {open&&<div style={{marginTop:12}}>{children}</div>}
  </div>;
}

function Sel({label,value,onChange,options}) {
  return <div><div style={{color:C.muted,fontSize:10,marginBottom:3}}>{label}</div>
    <select value={value} onChange={e=>onChange(e.target.value)} style={{width:"100%",background:C.card,border:`1px solid ${C.border}`,borderRadius:7,padding:"7px 11px",color:C.text,fontFamily:"inherit",fontSize:13,outline:"none"}}>
      {options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  </div>;
}


export default function App() {
  const [mType,setMType]=useState("regulated");
  const [results,setResults]=useState({});
  const [report,setReport]=useState(null);
  const [generating,setGenerating]=useState(false);
  const [cd,setCd]=useState({name:"",income:"",propertyValue:"",deposit:""});
  const [pd,setPd]=useState({propertyType:"",tenure:"freehold",leaseYears:"",mortgageTerm:"25",newBuild:"no",exCouncil:"no",purchaseScheme:"none"});
  const [exp,setExp]=useState({loans:"",carFinance:"",creditCards:"",childMaintenance:"",existingMortgage:"",schoolFees:"",other:""});
  const [secondaryIncome,setSecondaryIncome]=useState({rentalIncome:"",dividends:"",benefits:"",contractorDayRate:"",contractorWeeksPerYear:"46"});
  const [chRegNum,setChRegNum]=useState("");
  const [chData,setChData]=useState(null);
  const [chLoading,setChLoading]=useState(false);
  const [sessions,setSessions]=useState(()=>{try{return JSON.parse(localStorage.getItem("mba3")||"[]")}catch{return []}});
  const [showSessions,setShowSessions]=useState(false);
  const [toast,setToast]=useState(null);
  const [qStatus,setQStatus]=useState("");
  const [showExp,setShowExp]=useState(false);
  const [showProp,setShowProp]=useState(false);
  const [showIncome,setShowIncome]=useState(false);

  const queueRef=useRef([]);
  const busyRef=useRef(false);

  const showToast=(msg,type="success")=>{setToast({msg,type});setTimeout(()=>setToast(null),3000);};

  // ── Analysis ────────────────────────────────────────────────────────────────
  const runOne=useCallback(async(docId,file,slotIdx)=>{
    try {
      const isImg=file.type.startsWith("image/");
      const isPdf=file.type==="application/pdf";
      const b64=await toBase64(file);
      const label=DOC_TYPES.find(d=>d.id===docId)?.label||docId;
      const msg=`Mortgage type: ${mType.toUpperCase()}. Client name: ${cd.name||"not provided"}. Analyse this ${label} document (file: ${file.name}). Apply checks from your instructions. Extract all visible data. Return valid JSON only.`;
      const blocks=isPdf?[{type:"document",source:{type:"base64",media_type:"application/pdf",data:b64}},{type:"text",text:msg}]:isImg?[{type:"image",source:{type:"base64",media_type:file.type,data:b64}},{type:"text",text:msg}]:[{type:"text",text:msg+" (File not readable — provide basic framework.)"}];
      const raw=await callAPI({model:"claude-sonnet-4-6",max_tokens:4000,system:getPrompt(docId),messages:[{role:"user",content:blocks}]},file.name,setQStatus);
      const parsed=tryJSON(raw)||{document_type:"Unknown",key_data:{},rule_checks:[],flags:[{severity:"MEDIUM",rule_ref:"SYSTEM",message:"Could not parse response — re-upload."}],summary:"Parse failed.",passed:false};
      setResults(prev=>{const slots=[...(prev[docId]||[])];if(slots[slotIdx])slots[slotIdx]={...slots[slotIdx],loading:false,result:parsed};return{...prev,[docId]:slots};});
    } catch(err) {
      setResults(prev=>{const slots=[...(prev[docId]||[])];if(slots[slotIdx])slots[slotIdx]={...slots[slotIdx],loading:false,result:{passed:false,key_data:{},rule_checks:[],flags:[{severity:"HIGH",rule_ref:"SYSTEM",message:err.message}],summary:`Failed: ${err.message}`}};return{...prev,[docId]:slots};});
    }
  },[mType,cd.name]);

  const processQueue=useRef(async()=>{
    if(busyRef.current)return;
    busyRef.current=true;
    while(queueRef.current.length>0){
      const job=queueRef.current.shift();
      const rem=queueRef.current.length;
      setQStatus(`Analysing ${job.file.name}${rem>0?` · ${rem} more queued`:""}`);
      await runOne(job.docId,job.file,job.slotIdx);
      if(queueRef.current.length>0){setQStatus("Waiting 4s before next document...");await new Promise(r=>setTimeout(r,4000));}
    }
    busyRef.current=false;
    setQStatus("");
  });

  const addToQueue=useCallback((docId,file)=>{
    const doc=DOC_TYPES.find(d=>d.id===docId);
    setResults(prev=>{
      const existing=prev[docId]||[];
      if(existing.length>=(doc?.maxFiles||1))return prev;
      const slotIdx=existing.length;
      queueRef.current.push({docId,file,slotIdx});
      processQueue.current();
      return{...prev,[docId]:[...existing,{fileName:file.name,loading:true,result:null}]};
    });
  },[]);

  const removeSlot=(docId,idx)=>{setResults(prev=>({...prev,[docId]:(prev[docId]||[]).filter((_,i)=>i!==idx)}));};

  // ── Companies House lookup ─────────────────────────────────────────────────
  const lookupCH=async()=>{
    if(!chRegNum){showToast("Enter a company registration number","error");return;}
    setChLoading(true);
    setChData(null);
    const data=await companiesHouseCheck(chRegNum);
    setChData(data);
    setChLoading(false);
    if(data?.error)showToast("Lookup failed: "+data.error,"error");
    else showToast("Companies House lookup complete");
  };

  // ── Report generation ────────────────────────────────────────────────────────
  const generateReport=async()=>{
    setGenerating(true);
    try {
      const inc=parseFloat(cd.income)||0;
      const pv=parseFloat(cd.propertyValue)||0;
      const dep=parseFloat(cd.deposit)||0;
      const loan=pv-dep;
      const ltv=pv>0?Math.round((loan/pv)*100):0;
      const max45=inc*4.5;
      const term=parseFloat(pd.mortgageTerm||25);
      const totalCommitted=Object.values(exp).reduce((a,b)=>a+(parseFloat(b)||0),0);
      const contDayRate=parseFloat(secondaryIncome.contractorDayRate||0);
      const contWeeks=parseFloat(secondaryIncome.contractorWeeksPerYear||46);
      const contIncome=contDayRate>0?contDayRate*5*contWeeks:0;
      const totalIncome=inc+(parseFloat(secondaryIncome.rentalIncome||0)*12)+(parseFloat(secondaryIncome.dividends||0)*12)+(parseFloat(secondaryIncome.benefits||0)*12)+contIncome;

      const products=[{label:"2yr Fix",rate:4.39},{label:"5yr Fix",rate:4.15},{label:"Tracker",rate:5.25}];
      const scenarios=[];
      for(const p of products)for(const t of [20,25,30]){
        const mr=p.rate/100/12,smr=6/100/12,n=t*12;
        const pmt=(r,n)=>loan>0?Math.round(loan*(r*Math.pow(1+r,n))/(Math.pow(1+r,n)-1)):0;
        scenarios.push({label:p.label,loan:Math.round(loan),rate:p.rate,term:t,monthly:pmt(mr,n),stressMonthly:pmt(smr,n),ltv,total:pmt(mr,n)*n});
      }

      // Run cross-document checks
      const crossResult=runCrossDocumentChecks(results,cd,pd,exp);

      const allSlots=Object.values(results).flatMap(s=>s||[]);
      const allFlags=allSlots.flatMap(s=>s.result?.flags||[]);
      const allChecks=allSlots.flatMap(s=>s.result?.rule_checks||[]);
      const allFlagsInc=[...allFlags,...crossResult.flags];
      const hf=allFlagsInc.filter(f=>f.severity==="HIGH");
      const mf=allFlagsInc.filter(f=>f.severity==="MEDIUM");

      const docSummary=Object.entries(results).map(([k,slots])=>{
        const up=(slots||[]).filter(s=>s.result);if(!up.length)return null;
        const fl=up.flatMap(s=>s.result?.flags||[]);
        return `${DOC_TYPES.find(d=>d.id===k)?.label||k}: ${up.length} file(s), ${fl.filter(f=>f.severity==="HIGH").length} HIGH, ${fl.filter(f=>f.severity==="MEDIUM").length} MEDIUM`;
      }).filter(Boolean).join("\n");

      const stress25=scenarios.find(s=>s.term===25&&s.label==="5yr Fix");
      const monthlyNet=Math.round((inc*0.75)/12);
      const disposable=monthlyNet-totalCommitted-(stress25?.stressMonthly||0);

      const propFlags=[];
      if(pd.tenure==="leasehold"){
        const lease=parseFloat(pd.leaseYears||0);
        if(lease>0&&lease<(term+70))propFlags.push(`LEASEHOLD FLAG: ${pd.leaseYears} years remaining — most lenders require lease to exceed mortgage term plus 70 years (need ${term+70} years minimum)`);
      }
      if(pd.newBuild==="yes")propFlags.push("NEW BUILD: Most lenders cap at 85% LTV for new build properties");
      if(pd.exCouncil==="yes")propFlags.push("EX-LOCAL AUTHORITY: Many lenders cap at 70-75% LTV or decline for high-rise ex-council");
      if(pd.purchaseScheme!=="none")propFlags.push(`PURCHASE SCHEME: ${pd.purchaseScheme} — different affordability and LTV rules apply`);

      const prompt=`Senior UK mortgage underwriter. Produce formal compliance and affordability report.

CASE:
Mortgage type: ${mType.toUpperCase()}
Client: ${cd.name||"Not provided"}
Annual gross income: £${inc.toLocaleString()}
Secondary/blended income: £${Math.round(totalIncome-inc).toLocaleString()} per year (rental: £${secondaryIncome.rentalIncome||0}/mo, dividends: £${secondaryIncome.dividends||0}/mo, contractor: £${contIncome.toLocaleString()}/yr)
Total blended income: £${Math.round(totalIncome).toLocaleString()}
Property value: £${pv.toLocaleString()}
Deposit: £${dep.toLocaleString()}
Loan: £${Math.round(loan).toLocaleString()}
LTV: ${ltv}%
Max borrow 4.5x: £${Math.round(max45).toLocaleString()}
Within 4.5x limit: ${loan<=max45?"YES PASS":"NO FAIL"}
Mortgage term: ${term} years
Monthly committed expenditure: £${totalCommitted.toLocaleString()} (loans:${exp.loans||0}, car:${exp.carFinance||0}, cards:${exp.creditCards||0}, maintenance:${exp.childMaintenance||0}, existing mortgage:${exp.existingMortgage||0}, other:${exp.other||0})
Stress test (MCOB 11.6.5): Monthly at 6% 25yr = £${stress25?.stressMonthly?.toLocaleString()||"N/A"}. Estimated disposable after committed outgoings and stress payment: £${disposable.toLocaleString()} (${disposable<0?"FAIL — negative":"PASS"})
Property: ${pd.propertyType||"N/A"}, ${pd.tenure}, ${pd.leaseYears?pd.leaseYears+" years lease":"N/A"}, New build: ${pd.newBuild}, Ex-council: ${pd.exCouncil}, Scheme: ${pd.purchaseScheme}
${propFlags.length?`Property flags: ${propFlags.join("; ")}`:""} 
${mType==="non-regulated"?`BTL rental needed: £${Math.round((stress25?.stressMonthly||0)*1.25)}/mo (125%) or £${Math.round((stress25?.stressMonthly||0)*1.45)}/mo (145%) at 5.5% stress`:""}

DOCUMENTS: ${docSummary||"None"}
HIGH FLAGS (${hf.length}): ${hf.slice(0,10).map(f=>`[${f.rule_ref||""}] ${f.message}`).join("; ")||"None"}
MEDIUM FLAGS (${mf.length}): ${mf.slice(0,6).map(f=>`[${f.rule_ref||""}] ${f.message}`).join("; ")||"None"}
CROSS-DOCUMENT FLAGS: ${crossResult.flags.map(f=>`[${f.severity}] ${f.message}`).join("; ")||"None"}
Rule checks: ${allChecks.length} total, ${allChecks.filter(c=>c.result==="FAIL").length} failed.

Return ONLY valid JSON:
{"recommendation":"PROCEED|REFER|DECLINE","recommendation_reason":"one sentence","summary":"3-5 sentence narrative referencing MCOB 11.6 MLR 2017 etc","affordability_verdict":"PASS|FAIL|BORDERLINE","affordability_detail":"specific finding including committed expenditure and stress test","aml_verdict":"CLEAR|FLAGS_PRESENT|HIGH_RISK","kyc_verdict":"PASS|FAIL|PENDING","key_points":["point with rule ref","point","point","point","point"],"compliance_notes":["note","note"],"lender_suitability":"brief note on lender type based on all findings"}`;

      const raw=await callAPI({model:"claude-sonnet-4-6",max_tokens:2000,messages:[{role:"user",content:prompt}]},"report",null);
      const parsed=tryJSON(raw)||{};
      setReport({...parsed,scenarios,loanAmount:loan,ltv,maxBorrow:max45,income:inc,totalIncome,propertyValue:pv,deposit:dep,allFlags:allFlagsInc,allChecks,crossFlags:crossResult.flags,crossChecks:crossResult.checks});
    } catch(err) {
      const inc=parseFloat(cd.income)||0,pv=parseFloat(cd.propertyValue)||0,dep=parseFloat(cd.deposit)||0,loan=pv-dep,ltv=pv>0?Math.round((loan/pv)*100):0;
      const products=[{label:"2yr Fix",rate:4.39},{label:"5yr Fix",rate:4.15},{label:"Tracker",rate:5.25}];
      const scenarios=[];
      for(const p of products)for(const t of [20,25,30]){const mr=p.rate/100/12,smr=6/100/12,n=t*12;const pmt=(r,n)=>loan>0?Math.round(loan*(r*Math.pow(1+r,n))/(Math.pow(1+r,n)-1)):0;scenarios.push({label:p.label,loan:Math.round(loan),rate:p.rate,term:t,monthly:pmt(mr,n),stressMonthly:pmt(smr,n),ltv,total:pmt(mr,n)*n});}
      const allFlags=Object.values(results).flatMap(s=>s||[]).flatMap(s=>s.result?.flags||[]);
      setReport({recommendation:"REFER",recommendation_reason:`Error: ${err.message}`,summary:`Could not generate AI summary: ${err.message}`,affordability_verdict:loan<=inc*4.5?"PASS":"FAIL",affordability_detail:"Manual review required.",aml_verdict:"FLAGS_PRESENT",kyc_verdict:"PENDING",key_points:["Review all HIGH flags before proceeding"],compliance_notes:[`Error: ${err.message}`],lender_suitability:"Unable to determine.",scenarios,loanAmount:loan,ltv,maxBorrow:inc*4.5,income:inc,propertyValue:pv,deposit:dep,allFlags,allChecks:[],crossFlags:[],crossChecks:[]});
    }
    setGenerating(false);
  };

  const saveSession=()=>{
    const s={clientName:cd.name||"Unnamed",savedAt:new Date().toLocaleDateString("en-GB"),mType,cd,pd,exp,secondaryIncome,results,report,rec:report?.recommendation};
    const u=[s,...sessions].slice(0,10);setSessions(u);
    try{localStorage.setItem("mba3",JSON.stringify(u))}catch{}
    showToast("Session saved");
  };
  const loadSession=(s)=>{setMType(s.mType);setCd(s.cd||{});setPd(s.pd||{propertyType:"",tenure:"freehold",leaseYears:"",mortgageTerm:"25",newBuild:"no",exCouncil:"no",purchaseScheme:"none"});setExp(s.exp||{});setSecondaryIncome(s.secondaryIncome||{});setResults(s.results||{});setReport(s.report);setShowSessions(false);showToast("Session loaded");};
  const delSession=(i)=>{const u=sessions.filter((_,j)=>j!==i);setSessions(u);try{localStorage.setItem("mba3",JSON.stringify(u))}catch{};};
  const clearAll=()=>{setResults({});setReport(null);setCd({name:"",income:"",propertyValue:"",deposit:""});setPd({propertyType:"",tenure:"freehold",leaseYears:"",mortgageTerm:"25",newBuild:"no",exCouncil:"no",purchaseScheme:"none"});setExp({loans:"",carFinance:"",creditCards:"",childMaintenance:"",existingMortgage:"",schoolFees:"",other:""});setSecondaryIncome({rentalIncome:"",dividends:"",contractorDayRate:"",contractorWeeksPerYear:"46",benefits:""});setChData(null);showToast("Cleared");};

  const uploadedCount=Object.values(results).filter(s=>(s||[]).length>0).length;
  const totalHigh=Object.values(results).flatMap(s=>s||[]).flatMap(s=>s.result?.flags||[]).filter(f=>f.severity==="HIGH").length;
  const crossHighCount=(report?.crossFlags||[]).filter(f=>f.severity==="HIGH").length;
  const recColor=report?.recommendation==="PROCEED"?C.success:report?.recommendation==="DECLINE"?C.danger:C.warning;
  const loan=parseFloat(cd.propertyValue||0)-parseFloat(cd.deposit||0);
  const ltv=parseFloat(cd.propertyValue||0)>0?Math.round((loan/parseFloat(cd.propertyValue))*100):0;
  const max45=parseFloat(cd.income||0)*4.5;
  const totalCommitted=Object.values(exp).reduce((a,b)=>a+(parseFloat(b)||0),0);
  const contIncome=(parseFloat(secondaryIncome.contractorDayRate||0)*5*(parseFloat(secondaryIncome.contractorWeeksPerYear||46)));
  const totalIncome=parseFloat(cd.income||0)+(parseFloat(secondaryIncome.rentalIncome||0)*12)+(parseFloat(secondaryIncome.dividends||0)*12)+(parseFloat(secondaryIncome.benefits||0)*12)+contIncome;



  return <div style={{minHeight:"100vh",background:C.bg,color:C.text,fontFamily:"'DM Mono','Courier New',monospace",padding:"18px 14px"}}>
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@700;800&display=swap');
      *{box-sizing:border-box}
      @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
      @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
      @keyframes slideDown{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}
      ::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:#111827}::-webkit-scrollbar-thumb{background:#334155;border-radius:3px}
      select option{background:#1a2235}
    `}</style>

    {toast&&<div style={{position:"fixed",top:18,right:18,zIndex:999,background:toast.type==="success"?C.success:C.danger,color:"#fff",padding:"9px 18px",borderRadius:9,fontSize:12,fontWeight:700,animation:"slideDown 0.3s ease",boxShadow:"0 4px 20px rgba(0,0,0,0.4)"}}>{toast.msg}</div>}

    <div style={{maxWidth:980,margin:"0 auto"}}>

      {/* Header */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:10}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:34,height:34,background:C.accent,borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",fontSize:17}}>🏦</div>
          <div>
            <div style={{fontFamily:"'Syne',sans-serif",fontSize:20,fontWeight:800,letterSpacing:-0.5}}>MORTGAGE AI ASSISTANT</div>
            <div style={{color:C.muted,fontSize:10,letterSpacing:1.5}}>FCA MCOB · AML/MLR 2017 · KYC/JMLSG · CROSS-DOC MATCHING · 8 RULE SETS</div>
          </div>
        </div>
        <div style={{display:"flex",gap:8}}>
          <button onClick={()=>setShowSessions(!showSessions)} style={{background:C.panel,border:`1px solid ${C.border}`,color:C.text,borderRadius:8,padding:"6px 12px",fontSize:11,cursor:"pointer",fontFamily:"inherit",fontWeight:700}}>📂 Sessions{sessions.length>0&&` (${sessions.length})`}</button>
          <button onClick={clearAll} style={{background:"transparent",border:`1px solid ${C.border}`,color:C.muted,borderRadius:8,padding:"6px 12px",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>🗑 Clear</button>
        </div>
      </div>

      {/* Rule tags */}
      <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:12}}>
        {["MCOB 11.6","MCOB 11.6.5","MLR 2017 AML","KYC/JMLSG","Cross-Doc Match","Income Blend","Property Checks","Retirement Age","UK GDPR"].map(r=><span key={r} style={{background:C.accent+"15",border:`1px solid ${C.accent}30`,color:C.accent,borderRadius:4,padding:"2px 7px",fontSize:9,fontWeight:700,letterSpacing:0.5}}>{r}</span>)}
      </div>

      {/* Alerts */}
      {(totalHigh>0||crossHighCount>0)&&<div style={{marginBottom:12,padding:"8px 14px",background:C.danger+"15",border:`1px solid ${C.danger}40`,borderRadius:8,color:C.danger,fontSize:12,fontWeight:700}}>⚠ {totalHigh+crossHighCount} HIGH RISK FLAG{totalHigh+crossHighCount>1?"S":""} DETECTED</div>}
      {qStatus&&<div style={{marginBottom:12,padding:"8px 14px",background:C.accent+"15",border:`1px solid ${C.accent}40`,borderRadius:8,color:C.accent,fontSize:11,fontWeight:700,animation:"pulse 1.5s infinite"}}>⏳ {qStatus}</div>}

      {/* Sessions */}
      {showSessions&&<div style={{animation:"slideDown 0.2s ease",background:C.panel,border:`1px solid ${C.border}`,borderRadius:12,padding:14,marginBottom:14}}>
        <div style={{color:C.muted,fontSize:10,fontWeight:700,letterSpacing:1,marginBottom:10}}>SAVED SESSIONS</div>
        {sessions.length===0?<div style={{color:C.muted,fontSize:11}}>No saved sessions yet.</div>:sessions.map((s,i)=><div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 0",borderBottom:`1px solid ${C.border}`}}>
          <div><div style={{color:C.text,fontSize:12,fontWeight:700}}>{s.clientName}</div><div style={{color:C.muted,fontSize:10}}>{s.savedAt} · {s.mType} {s.rec&&`· ${s.rec}`}</div></div>
          <div style={{display:"flex",gap:6}}>
            <button onClick={()=>loadSession(s)} style={{background:C.accent+"20",border:`1px solid ${C.accent}`,color:C.accent,borderRadius:5,padding:"3px 10px",fontSize:10,cursor:"pointer",fontFamily:"inherit",fontWeight:700}}>Load</button>
            <button onClick={()=>delSession(i)} style={{background:"transparent",border:`1px solid ${C.danger}40`,color:C.danger,borderRadius:5,padding:"3px 8px",fontSize:10,cursor:"pointer",fontFamily:"inherit"}}>✕</button>
          </div>
        </div>)}
      </div>}

      {/* Mortgage type */}
      <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:12,padding:14,marginBottom:14}}>
        <div style={{color:C.muted,fontSize:10,fontWeight:700,letterSpacing:1,marginBottom:8}}>MORTGAGE TYPE</div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          {["regulated","non-regulated"].map(t=><button key={t} onClick={()=>setMType(t)} style={{padding:"7px 16px",borderRadius:8,border:`1px solid ${mType===t?C.accent:C.border}`,background:mType===t?C.accent+"20":"transparent",color:mType===t?C.accent:C.muted,fontFamily:"inherit",fontSize:12,fontWeight:700,cursor:"pointer",textTransform:"uppercase"}}>{t==="regulated"?"🏘 Regulated (Residential)":"🏗 Non-Regulated (BTL/Commercial)"}</button>)}
        </div>
        <div style={{marginTop:6,color:C.muted,fontSize:10}}>{mType==="regulated"?"Full MCOB 11.6 + 11.6.5 stress test + AML/KYC + cross-document matching.":"BTL rental coverage 125%/145% at 5.5% stress + AML/KYC."}</div>
      </div>

      {/* Client details */}
      <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:12,padding:14,marginBottom:14}}>
        <div style={{color:C.muted,fontSize:10,fontWeight:700,letterSpacing:1,marginBottom:10}}>CLIENT DETAILS</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
          <Input label="Client Full Name" value={cd.name} onChange={v=>setCd(p=>({...p,name:v}))} placeholder="e.g. John Smith"/>
          <div style={{display:"flex",alignItems:"center"}}><span style={{color:C.muted,fontSize:10}}>Name must match exactly across all documents (KYC Rule 3 — MLR 2017)</span></div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
          <Input label="Annual Gross Income (£)" type="number" value={cd.income} onChange={v=>setCd(p=>({...p,income:v}))} placeholder="45000"/>
          <Input label="Property Value (£)" type="number" value={cd.propertyValue} onChange={v=>setCd(p=>({...p,propertyValue:v}))} placeholder="250000"/>
          <Input label="Deposit (£)" type="number" value={cd.deposit} onChange={v=>setCd(p=>({...p,deposit:v}))} placeholder="25000"/>
        </div>
        {cd.income&&cd.propertyValue&&cd.deposit&&<div style={{marginTop:10,display:"flex",gap:10,flexWrap:"wrap"}}>
          {[{label:"Loan Amount",val:`£${loan.toLocaleString()}`,col:C.accent},{label:"LTV",val:`${ltv}%`,col:ltv>85?C.danger:ltv>75?C.warning:C.success},{label:"Max Borrow (4.5x)",val:`£${Math.round(max45).toLocaleString()}`,col:C.accent},{label:"Within Limit",val:loan<=max45?"✓ YES":"✗ NO",col:loan<=max45?C.success:C.danger},{label:"Total Income (Blended)",val:`£${Math.round(totalIncome).toLocaleString()}`,col:C.gold}].map(s=><div key={s.label} style={{background:C.card,borderRadius:7,padding:"5px 12px"}}>
            <div style={{color:C.muted,fontSize:9}}>{s.label}</div>
            <div style={{color:s.col,fontSize:15,fontWeight:700}}>{s.val}</div>
          </div>)}
        </div>}
      </div>

      {/* Secondary income */}
      <PanelToggle label="SECONDARY / BLENDED INCOME (OPTIONAL)" open={showIncome} toggle={()=>setShowIncome(!showIncome)}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
          <Input label="Rental Income (£/month)" type="number" value={secondaryIncome.rentalIncome} onChange={v=>setSecondaryIncome(p=>({...p,rentalIncome:v}))} placeholder="0"/>
          <Input label="Dividends (£/month)" type="number" value={secondaryIncome.dividends} onChange={v=>setSecondaryIncome(p=>({...p,dividends:v}))} placeholder="0"/>
          <Input label="Benefits (£/month)" type="number" value={secondaryIncome.benefits} onChange={v=>setSecondaryIncome(p=>({...p,benefits:v}))} placeholder="0"/>
          <Input label="Contractor Day Rate (£)" type="number" value={secondaryIncome.contractorDayRate} onChange={v=>setSecondaryIncome(p=>({...p,contractorDayRate:v}))} placeholder="0"/>
          <Input label="Contractor Weeks/Year" type="number" value={secondaryIncome.contractorWeeksPerYear} onChange={v=>setSecondaryIncome(p=>({...p,contractorWeeksPerYear:v}))} placeholder="46"/>
          {secondaryIncome.contractorDayRate&&<div style={{display:"flex",alignItems:"center"}}><div style={{background:C.card,borderRadius:7,padding:"5px 12px"}}><div style={{color:C.muted,fontSize:9}}>Contractor Annualised</div><div style={{color:C.gold,fontSize:15,fontWeight:700}}>£{Math.round(contIncome).toLocaleString()}</div></div></div>}
        </div>
        <div style={{marginTop:8,color:C.muted,fontSize:10}}>Note: lenders typically accept 50% of overtime/bonus/commission. Rental income accepted at 75-80% by most lenders. Contractor income = day rate x 5 x weeks (MCOB 11.6).</div>
      </PanelToggle>

      {/* Committed expenditure */}
      <PanelToggle label="MONTHLY COMMITTED EXPENDITURE — REQUIRED FOR MCOB 11.6.5 STRESS TEST" open={showExp} toggle={()=>setShowExp(!showExp)}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
          <Input label="Loans (£/month)" type="number" value={exp.loans} onChange={v=>setExp(p=>({...p,loans:v}))} placeholder="0"/>
          <Input label="Car Finance (£/month)" type="number" value={exp.carFinance} onChange={v=>setExp(p=>({...p,carFinance:v}))} placeholder="0"/>
          <Input label="Credit Card Min. Payments (£/month)" type="number" value={exp.creditCards} onChange={v=>setExp(p=>({...p,creditCards:v}))} placeholder="0"/>
          <Input label="Child Maintenance (£/month)" type="number" value={exp.childMaintenance} onChange={v=>setExp(p=>({...p,childMaintenance:v}))} placeholder="0"/>
          <Input label="Existing Mortgage (£/month)" type="number" value={exp.existingMortgage} onChange={v=>setExp(p=>({...p,existingMortgage:v}))} placeholder="0"/>
          <Input label="School Fees (£/month)" type="number" value={exp.schoolFees} onChange={v=>setExp(p=>({...p,schoolFees:v}))} placeholder="0"/>
          <Input label="Other Regular Commitments (£/month)" type="number" value={exp.other} onChange={v=>setExp(p=>({...p,other:v}))} placeholder="0"/>
          <div style={{display:"flex",alignItems:"center"}}><div style={{background:C.card,borderRadius:7,padding:"5px 12px"}}><div style={{color:C.muted,fontSize:9}}>Total Monthly Committed</div><div style={{color:totalCommitted>0?C.danger:C.muted,fontSize:15,fontWeight:700}}>£{totalCommitted.toLocaleString()}</div></div></div>
        </div>
      </PanelToggle>

      {/* Property details */}
      <PanelToggle label="PROPERTY DETAILS — REQUIRED FOR LEASEHOLD, NEW BUILD & SCHEME CHECKS" open={showProp} toggle={()=>setShowProp(!showProp)}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
          <Input label="Property Type" value={pd.propertyType} onChange={v=>setPd(p=>({...p,propertyType:v}))} placeholder="e.g. Flat, Terraced, Detached"/>
          <Sel label="Tenure" value={pd.tenure} onChange={v=>setPd(p=>({...p,tenure:v}))} options={[{value:"freehold",label:"Freehold"},{value:"leasehold",label:"Leasehold"},{value:"share_of_freehold",label:"Share of Freehold"}]}/>
          {pd.tenure==="leasehold"&&<Input label="Lease Years Remaining" type="number" value={pd.leaseYears} onChange={v=>setPd(p=>({...p,leaseYears:v}))} placeholder="e.g. 125"/>}
          <Input label="Mortgage Term (years)" type="number" value={pd.mortgageTerm} onChange={v=>setPd(p=>({...p,mortgageTerm:v}))} placeholder="25"/>
          <Sel label="New Build?" value={pd.newBuild} onChange={v=>setPd(p=>({...p,newBuild:v}))} options={[{value:"no",label:"No"},{value:"yes",label:"Yes"}]}/>
          <Sel label="Ex-Local Authority?" value={pd.exCouncil} onChange={v=>setPd(p=>({...p,exCouncil:v}))} options={[{value:"no",label:"No"},{value:"yes",label:"Yes"}]}/>
          <Sel label="Purchase Scheme" value={pd.purchaseScheme} onChange={v=>setPd(p=>({...p,purchaseScheme:v}))} options={[{value:"none",label:"None"},{value:"right_to_buy",label:"Right to Buy"},{value:"help_to_buy",label:"Help to Buy"},{value:"shared_ownership",label:"Shared Ownership"},{value:"first_homes",label:"First Homes"}]}/>
        </div>
        {pd.tenure==="leasehold"&&pd.leaseYears&&<div style={{marginTop:8,padding:"7px 10px",background:parseFloat(pd.leaseYears)<(parseFloat(pd.mortgageTerm||25)+70)?C.danger+"15":C.success+"15",border:`1px solid ${parseFloat(pd.leaseYears)<(parseFloat(pd.mortgageTerm||25)+70)?C.danger:C.success}40`,borderRadius:7,color:parseFloat(pd.leaseYears)<(parseFloat(pd.mortgageTerm||25)+70)?C.danger:C.success,fontSize:11,fontWeight:700}}>
          {parseFloat(pd.leaseYears)<(parseFloat(pd.mortgageTerm||25)+70)?`⚠ LEASEHOLD ISSUE: ${pd.leaseYears} years remaining — need ${parseFloat(pd.mortgageTerm||25)+70} years minimum (term + 70). Most lenders will decline.`:`✓ Lease OK: ${pd.leaseYears} years remaining (need ${parseFloat(pd.mortgageTerm||25)+70} minimum)`}
        </div>}
      </PanelToggle>

      {/* Companies House */}
      <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:12,padding:14,marginBottom:14}}>
        <div style={{color:C.muted,fontSize:10,fontWeight:700,letterSpacing:1,marginBottom:10}}>COMPANIES HOUSE VERIFICATION (FREE API — DIRECTORS/SELF-EMPLOYED ONLY)</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:10,alignItems:"end"}}>
          <Input label="Company Registration Number" value={chRegNum} onChange={setChRegNum} placeholder="e.g. 12345678"/>
          <button onClick={lookupCH} disabled={chLoading} style={{padding:"7px 16px",background:C.accent,border:"none",borderRadius:8,color:"#fff",fontFamily:"inherit",fontSize:12,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",opacity:chLoading?0.7:1,height:38,alignSelf:"flex-end"}}>{chLoading?"Searching...":"🔍 Lookup via AI"}</button>
        </div>
        <div style={{color:C.muted,fontSize:10,marginTop:6}}>Uses AI web search to look up Companies House — no API key required</div>
        {chData&&!chData.error&&<div style={{marginTop:10,background:C.card,borderRadius:8,padding:10}}>
          {/* Main info grid */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:8}}>
            {[
              {label:"COMPANY NAME",val:chData.company_name,full:true},
              {label:"STATUS",val:chData.company_status?.toUpperCase(),col:chData.company_status==="active"?C.success:C.danger},
              {label:"TYPE",val:chData.type},
              {label:"REG NUMBER",val:chData.company_number},
              {label:"INCORPORATED",val:chData.date_of_creation},
              {label:"NATURE OF BUSINESS",val:chData.nature_of_business},
            ].map(f=><div key={f.label} style={{background:C.panel,borderRadius:6,padding:"6px 9px",gridColumn:f.full?"1/-1":undefined}}><div style={{color:C.muted,fontSize:9,marginBottom:2}}>{f.label}</div><div style={{color:f.col||C.text,fontSize:f.full?13:11,fontWeight:700}}>{f.val||"N/A"}</div></div>)}
          </div>
          {/* Address */}
          {chData.registered_office_address&&<div style={{background:C.panel,borderRadius:6,padding:"6px 9px",marginBottom:8}}><div style={{color:C.muted,fontSize:9,marginBottom:2}}>REGISTERED ADDRESS</div><div style={{color:C.text,fontSize:11}}>{chData.registered_office_address}</div></div>}
          {/* Accounts & confirmation statement dates */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
            {[
              {label:"ACCOUNTS LAST MADE UP TO",val:chData.accounts_last_made_up},
              {label:"ACCOUNTS NEXT DUE",val:chData.accounts_next_due,warn:chData.accounts_overdue},
              {label:"CONF. STATEMENT LAST MADE UP",val:chData.confirmation_statement_last_made_up},
              {label:"CONF. STATEMENT NEXT DUE",val:chData.confirmation_statement_next_due,warn:chData.confirmation_statement_overdue},
            ].map(f=><div key={f.label} style={{background:C.panel,borderRadius:6,padding:"6px 9px"}}><div style={{color:C.muted,fontSize:9,marginBottom:2}}>{f.label}</div><div style={{color:f.warn?C.danger:C.text,fontSize:11,fontWeight:700}}>{f.val||"N/A"}{f.warn&&" ⚠ OVERDUE"}</div></div>)}
          </div>
          {/* Directors note + link */}
          <div style={{background:C.panel,borderRadius:6,padding:"6px 9px",marginBottom:8}}>
            <div style={{color:C.muted,fontSize:9,marginBottom:2}}>DIRECTORS</div>
            <div style={{color:C.text,fontSize:11}}>
              {chData.directors?.length>0
                ? chData.directors.join(", ")
                : <span>Cannot retrieve automatically — <a href={`https://find-and-update.company-information.service.gov.uk/company/${chData.company_number}/officers`} target="_blank" rel="noreferrer" style={{color:C.accent}}>Click here to check directors on Companies House ↗</a></span>
              }
            </div>
          </div>
          {/* Risk flags */}
          {chData.has_insolvency_history&&<div style={{padding:"6px 9px",background:C.danger+"15",borderRadius:6,color:C.danger,fontSize:11,fontWeight:700,marginBottom:6}}>⚠ HIGH RISK: Insolvency history on record</div>}
          {(chData.confirmation_statement_overdue||chData.accounts_overdue)&&<div style={{padding:"6px 9px",background:C.warning+"15",borderRadius:6,color:C.warning,fontSize:11,fontWeight:700,marginBottom:6}}>⚠ OVERDUE: {[chData.confirmation_statement_overdue&&"Confirmation statement",chData.accounts_overdue&&"Annual accounts"].filter(Boolean).join(" and ")} overdue — lenders may query this</div>}
          {chData.date_of_creation&&(()=>{const years=(new Date()-new Date(chData.date_of_creation))/(365.25*24*60*60*1000);return years<2?<div style={{marginTop:8,padding:"6px 10px",background:C.danger+"15",border:`1px solid ${C.danger}40`,borderRadius:6,color:C.danger,fontSize:11,fontWeight:700}}>⚠ Company incorporated {years.toFixed(1)} years ago — most lenders require minimum 2 years trading history</div>:<div style={{marginTop:8,padding:"6px 10px",background:C.success+"15",border:`1px solid ${C.success}40`,borderRadius:6,color:C.success,fontSize:11,fontWeight:700}}>✓ Company has {years.toFixed(1)} years trading history</div>})()}
          {chData.company_status!=="active"&&<div style={{marginTop:8,padding:"6px 10px",background:C.danger+"15",border:`1px solid ${C.danger}40`,borderRadius:6,color:C.danger,fontSize:11,fontWeight:700}}>⚠ HIGH RISK: Company status is {chData.company_status} — not active. Lenders will decline.</div>}
        </div>}
        {chData?.error&&<div style={{marginTop:8,color:C.danger,fontSize:11}}>Error: {chData.error} — Check the registration number and API key are correct</div>}
      </div>

      {/* Documents */}
      <div style={{color:C.muted,fontSize:10,fontWeight:700,letterSpacing:1,marginBottom:10}}>DOCUMENTS — {uploadedCount}/{DOC_TYPES.length} TYPES UPLOADED · SERIAL QUEUE ACTIVE</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:12,marginBottom:18}}>
        {DOC_TYPES.map(doc=><DocCard key={doc.id} doc={doc} slots={results[doc.id]||[]} onUpload={addToQueue} onRemove={removeSlot}/>)}
      </div>

      {/* Actions */}
      <button onClick={generateReport} disabled={generating||uploadedCount===0} style={{width:"100%",padding:"14px",background:uploadedCount>0?C.accent:C.subtle,border:"none",borderRadius:11,color:"#fff",fontFamily:"inherit",fontSize:13,fontWeight:800,cursor:uploadedCount>0?"pointer":"not-allowed",letterSpacing:1,marginBottom:10,opacity:generating?0.7:1}}>
        {generating?"⏳ GENERATING COMPLIANCE REPORT + CROSS-DOCUMENT MATCHING...":"📊 GENERATE FULL COMPLIANCE & AFFORDABILITY REPORT"}
      </button>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:18}}>
        <button onClick={saveSession} style={{padding:"11px",background:C.panel,border:`1px solid ${C.success}60`,color:C.success,borderRadius:10,fontFamily:"inherit",fontSize:12,fontWeight:700,cursor:"pointer"}}>💾 SAVE SESSION</button>
        <button onClick={()=>exportJSON({mType,cd,pd,exp,secondaryIncome,results,report,at:new Date().toISOString()})} disabled={uploadedCount===0} style={{padding:"11px",background:C.panel,border:`1px solid ${C.gold}60`,color:C.gold,borderRadius:10,fontFamily:"inherit",fontSize:12,fontWeight:700,cursor:uploadedCount>0?"pointer":"not-allowed",opacity:uploadedCount>0?1:0.4}}>⬇ EXPORT JSON</button>
        <button onClick={()=>report&&exportCSV(report.scenarios,cd,report)} disabled={!report} style={{padding:"11px",background:C.panel,border:`1px solid ${C.accent}60`,color:C.accent,borderRadius:10,fontFamily:"inherit",fontSize:12,fontWeight:700,cursor:report?"pointer":"not-allowed",opacity:report?1:0.4}}>⬇ EXPORT CSV</button>
      </div>

      {/* Report */}
      {report&&<div style={{animation:"fadeIn 0.4s ease",background:C.panel,border:`1px solid ${recColor}60`,borderRadius:14,padding:18,marginBottom:18}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:8}}>
          <div style={{fontFamily:"'Syne',sans-serif",fontSize:17,fontWeight:800}}>COMPLIANCE &amp; AFFORDABILITY REPORT</div>
          <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
            <div style={{padding:"6px 16px",borderRadius:7,background:recColor+"20",border:`1px solid ${recColor}`,color:recColor,fontWeight:800,fontSize:14,letterSpacing:1}}>{report.recommendation==="PROCEED"?"✓ PROCEED":report.recommendation==="DECLINE"?"✗ DECLINE":"⚠ REFER"}</div>
            <button onClick={()=>downloadReport(cd,pd,exp,results,report,mType,chData)} style={{padding:"6px 14px",borderRadius:7,background:"transparent",border:`1px solid ${C.border}`,color:C.text,fontFamily:"inherit",fontSize:11,fontWeight:700,cursor:"pointer"}}>⬇ DOWNLOAD PDF REPORT</button>
          </div>
        </div>

        {report.recommendation_reason&&<div style={{marginBottom:12,padding:"8px 12px",background:recColor+"10",borderLeft:`3px solid ${recColor}`,borderRadius:6,color:C.text,fontSize:12}}>{report.recommendation_reason}</div>}

        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:14}}>
          <Pill label="AFFORDABILITY" value={report.affordability_verdict} ok={report.affordability_verdict==="PASS"} warn={report.affordability_verdict==="BORDERLINE"}/>
          <Pill label="AML" value={report.aml_verdict} ok={report.aml_verdict==="CLEAR"} warn={report.aml_verdict==="FLAGS_PRESENT"}/>
          <Pill label="KYC" value={report.kyc_verdict} ok={report.kyc_verdict==="PASS"} warn={false}/>
          <Pill label="CROSS-DOC" value={(report.crossFlags||[]).filter(f=>f.severity==="HIGH").length>0?"ISSUES":"PASS"} ok={(report.crossFlags||[]).filter(f=>f.severity==="HIGH").length===0} warn={(report.crossFlags||[]).filter(f=>f.severity==="MEDIUM").length>0}/>
          {report.loanAmount>0&&<Pill label="LOAN" value={`£${Math.round(report.loanAmount).toLocaleString()}`} ok={true}/>}
          {report.ltv>0&&<Pill label="LTV" value={`${report.ltv}%`} ok={report.ltv<=75} warn={report.ltv<=85}/>}
        </div>

        <p style={{color:C.text,fontSize:13,lineHeight:1.7,marginBottom:12,padding:"10px 12px",background:C.card,borderRadius:8}}>{report.summary}</p>

        {report.affordability_detail&&<div style={{marginBottom:12,padding:"8px 12px",background:C.card,borderRadius:8}}><div style={{color:C.muted,fontSize:10,fontWeight:700,letterSpacing:1,marginBottom:4}}>AFFORDABILITY DETAIL</div><div style={{color:C.text,fontSize:12}}>{report.affordability_detail}</div></div>}

        {/* Cross-document matching results */}
        {report.crossFlags?.length>0&&<div style={{marginBottom:12}}>
          <div style={{color:C.accent,fontSize:10,fontWeight:700,letterSpacing:1,marginBottom:8}}>CROSS-DOCUMENT MATCHING RESULTS</div>
          {report.crossFlags.map((f,i)=><div key={i} style={{display:"flex",gap:8,padding:"6px 0",borderBottom:`1px solid ${C.border}`}}>
            <span style={{color:f.severity==="HIGH"?C.danger:f.severity==="MEDIUM"?C.warning:C.muted,fontSize:10,fontWeight:800,minWidth:55,flexShrink:0}}>{f.severity}</span>
            <div style={{fontSize:11}}><span style={{color:C.accent,fontSize:10}}>{f.rule_ref} · </span><span style={{color:C.text}}>{f.message}</span></div>
          </div>)}
        </div>}

        {report.key_points?.length>0&&<div style={{marginBottom:12}}>
          <div style={{color:C.muted,fontSize:10,fontWeight:700,letterSpacing:1,marginBottom:8}}>KEY POINTS FOR ADVISOR</div>
          {report.key_points.map((p,i)=><div key={i} style={{display:"flex",gap:8,padding:"6px 0",borderBottom:`1px solid ${C.border}`,color:C.text,fontSize:12}}><span style={{color:C.accent,fontWeight:800,minWidth:18}}>{i+1}.</span>{p}</div>)}
        </div>}

        {report.compliance_notes?.length>0&&<div style={{marginBottom:12}}>
          <div style={{color:C.muted,fontSize:10,fontWeight:700,letterSpacing:1,marginBottom:8}}>COMPLIANCE NOTES</div>
          {report.compliance_notes.map((n,i)=><div key={i} style={{padding:"5px 0",borderBottom:`1px solid ${C.border}`,color:C.muted,fontSize:11}}>📌 {n}</div>)}
        </div>}

        {report.lender_suitability&&<div style={{marginBottom:14,padding:"8px 12px",background:C.card,borderRadius:8}}><div style={{color:C.muted,fontSize:10,fontWeight:700,letterSpacing:1,marginBottom:4}}>LENDER SUITABILITY</div><div style={{color:C.text,fontSize:12}}>{report.lender_suitability}</div></div>}

        {report.scenarios?.length>0&&<div>
          <div style={{color:C.muted,fontSize:10,fontWeight:700,letterSpacing:1,marginBottom:8}}>REPAYMENT SCENARIOS + MCOB 11.6.5 STRESS TEST</div>
          <ScenarioTable scenarios={report.scenarios}/>
        </div>}
      </div>}

      <div style={{padding:"10px 14px",background:C.panel,border:`1px solid ${C.border}`,borderRadius:10,color:C.muted,fontSize:10,lineHeight:1.6}}>
        🔒 UK GDPR / DPA 2018: Documents processed in-session only — not stored beyond this browser session. Not regulated financial advice under FSMA 2000. All findings must be verified by a qualified FCA-authorised mortgage advisor.
      </div>
    </div>
  </div>;
}
