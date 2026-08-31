'use strict';
const crypto = require('crypto');
const { Contract } = require('fabric-contract-api');
function txTimeToISOString(txTime) {
  const ms = (Number(txTime.seconds) * 1000) + Math.floor(txTime.nanos / 1e6);
  return new Date(ms).toISOString();
}

// top of file, outside class
const SIM_MODE_KEY  = 'sim.mode';
const SIM_CLOCK_KEY = 'sim.clock';
const SIM_START_KEY = 'sim.start';

class SupplyChainContract extends Contract {

   _logInvocation(fnName, args, ctx) {
    console.log(`\n📥 Invoked function: ${fnName}`);
    console.log(`🔗 Transaction ID: ${ctx.stub.getTxID()}`);
    console.log(`📡 Channel ID: ${ctx.stub.getChannelID()}`);
    if (args && args.length) {
      for (let i = 0; i < args.length; i++) {
        console.log(`   └─ arg[${i}]:`, args[i]);
      }
    }
  }
  async getMSPID(ctx) {
    this._logInvocation("getMSPID", arguments, ctx);
    console.log("🚀 Function `getMSPID` invoked");
    return ctx.clientIdentity.getMSPID();
  }
   // Returns a stable, globally-unique user id for the caller.
// Default: "<MSP>:<enrollmentId>" (e.g., "FinanciersMSP:User1")
  // Always returns a normalized short id (e.g., "User2")
_clientId(ctx) {
  const cid = ctx.clientIdentity;

  // 1) Prefer Fabric-CA enrollment id
  try {
    const eid = cid.getAttributeValue && cid.getAttributeValue('hf.EnrollmentID');
    if (eid) return String(eid);
  } catch {}

  // 2) Try CN from parsed X.509
  try {
    const cn = cid.getX509Certificate?.().subject?.commonName || '';
    if (cn) return cn.includes('@') ? cn.split('@')[0] : cn;
  } catch {}

  // 3) Parse CN out of getID(): "x509::/…/CN=<CN>…::/…"
  try {
    const idStr = cid.getID?.() || '';
    const subject = idStr.split('::')[1] || idStr; // pull subject DN part if present
    const m = subject.match(/(?:^|,|\/)CN=([^\/,]+)/i);
    if (m?.[1]) {
      const cn = m[1];
      return cn.includes('@') ? cn.split('@')[0] : cn;
    }
  } catch {}

  // 4) Last resort: stable short hash
  const basis = (() => { try { return String(cid.getID()); } catch { return ''; } })();
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 12);
}

// (optional) keep your existing helpers consistent
_mspId(ctx) {
  return ctx.clientIdentity.getMSPID();
}

// (optional) alias for older code paths
_userId(ctx) {
  return this._clientId(ctx);
}
// Put this in your contract class
_txTimeISO(ctx) {
  const ts = ctx.stub.getTxTimestamp(); // { seconds: Long, nanos: number }
  const ms = Number(ts.seconds.low ?? ts.seconds) * 1000 + Math.floor(ts.nanos / 1e6);
  return new Date(ms).toISOString();
}
// governance keys


// returns ISO string deterministically
async _ledgerNowISO(ctx) {
  const ts = ctx.stub.getTxTimestamp();
  const ms = Number(ts.seconds.low ?? ts.seconds)*1000 + Math.floor(ts.nanos/1e6);
  return new Date(ms).toISOString();
}

async  _simNowISO(ctx) {
  // SIM_MODE?
  const modeBytes = await ctx.stub.getState(SIM_MODE_KEY);
  const simOn = (modeBytes?.length ? modeBytes.toString() : 'false').toLowerCase() === 'true';
  if (!simOn) return await this._ledgerNowISO(ctx);

  const clkBytes = await ctx.stub.getState(SIM_CLOCK_KEY);
  if (clkBytes?.length) return clkBytes.toString();

  // fallback to ledger time if clock unset
  return await this._ledgerNowISO(ctx);
}

async  setSimMode(ctx, onOff) {
  this._requireOrg(ctx, 'FinanciersMSP');               // adjust to your admin org
  const v = String(onOff).toLowerCase();
  if (!['true','false','1','0','on','off','yes','no'].includes(v))
    throw new Error('setSimMode expects boolean-like value');
  const norm = ['true','1','on','yes'].includes(v) ? 'true' : 'false';
  await ctx.stub.putState(SIM_MODE_KEY, Buffer.from(norm));
  return `SIM_MODE=${norm}`;
}



async setSimClock(ctx, iso) {
  this._requireOrg(ctx, 'FinanciersMSP');

  const t = Date.parse(String(iso));
  if (!Number.isFinite(t)) throw new Error('Invalid ISO timestamp');

  const newIso = new Date(t).toISOString();
  await ctx.stub.putState(SIM_CLOCK_KEY, Buffer.from(newIso));

  // set start only once (keeps original start time intact)
  const startBytes = await ctx.stub.getState(SIM_START_KEY);
  if (!startBytes?.length) {
    await ctx.stub.putState(SIM_START_KEY, Buffer.from(newIso));
  }
  return `SIM_CLOCK=${newIso}`;
}



async tickSimClock(ctx, deltaDays) {
  this._requireOrg(ctx, 'FinanciersMSP');
  const d = Number(deltaDays);
  if (!Number.isFinite(d)) throw new Error('tickSimClock expects a number of days');
  const curr = new Date(await this._simNowISO(ctx));
  curr.setUTCDate(curr.getUTCDate() + d);
  await ctx.stub.putState(SIM_CLOCK_KEY, Buffer.from(curr.toISOString()));
  return `SIM_CLOCK=${curr.toISOString()}`;
}

async getSimStatus(ctx) {
  const modeBytes  = await ctx.stub.getState(SIM_MODE_KEY);
  const clkBytes   = await ctx.stub.getState(SIM_CLOCK_KEY);
  const startBytes = await ctx.stub.getState(SIM_START_KEY);

  const mode  = modeBytes?.length ? modeBytes.toString() : 'false';
  const clock = clkBytes?.length ? clkBytes.toString() : null;
  const start = startBytes?.length ? startBytes.toString() : null;

  // Compute days passed (if both start and clock exist)
  let daysPassed = null;
  if (clock && start) {
    const startMs = Date.parse(start);
    const nowMs   = Date.parse(clock);
    if (Number.isFinite(startMs) && Number.isFinite(nowMs)) {
      daysPassed = Math.floor((nowMs - startMs) / (24 * 60 * 60 * 1000));
    }
  }

  return JSON.stringify({
    mode,
    clock,       // simulated clock time
    start,       // simulation start time
    daysPassed,  // ✅ total simulated days elapsed
    ledgerNow: await this._ledgerNowISO(ctx),
  });
}



// small internal helper
async _isSimOn(ctx) {
  const b = await ctx.stub.getState(SIM_MODE_KEY);
  return (b?.length ? b.toString() : 'false').toLowerCase() === 'true';
}



_getPacketOwner(packet) {
  const org = packet.ownerOrg || 'wholesalers';            // your packer put wholesaler as owner
  const id  = packet.ownerId  || String(packet.owner || ''); // fall back to legacy `owner`
  return { org, id };
}


_setPacketOwner(packet, org, id) {
  packet.ownerOrg = String(org);
  packet.ownerId  = String(id);
  packet.owner    = String(id); // keep legacy field in sync for older code paths
}


async _drainIteratorKV(iterator) {
    const out = [];
    for (let r = await iterator.next(); !r.done; r = await iterator.next()) {
      const { key, value } = r.value || {};
      out.push({ key, value: value ? value.toString('utf8') : '' });
    }
    await iterator.close();
    return out;
  }

  async _drainIteratorValues(iterator) {
    const out = [];
    for (let r = await iterator.next(); !r.done; r = await iterator.next()) {
      if (r.value?.value) out.push(r.value.value.toString('utf8'));
    }
    await iterator.close();
    return out;
  }


  _requireOrg(ctx, requiredMSP) {
    
    console.log("🚀 Function `_requireOrg` invoked");
    this._logInvocation("requireOrg", arguments, ctx);
    const callerMSP = ctx.clientIdentity.getMSPID();
    if (callerMSP !== requiredMSP) {
      throw new Error(`Access denied: Only members of ${requiredMSP} can perform this action. Caller MSP: ${callerMSP}`);
    }
  }



  // ====================== WALLET ======================
async createWallet(ctx, org, userId) {
    this._logInvocation("createWallet", arguments, ctx);
    console.log("🚀 Function `createWallet` invoked");

    this._requireOrg(ctx, 'BankMSP');
    const walletKey = `${org}-${userId}-wallet`;

    const existing = await ctx.stub.getState(walletKey);
    if (existing && existing.length > 0) throw new Error('Wallet already exists');

    const wallet = {
        owner: userId,
        org,
        createdAt: new Date().toISOString(),
        docType: 'wallet'
    };

    await ctx.stub.putState(walletKey, Buffer.from(JSON.stringify(wallet)));
    return `✅ Wallet created for ${walletKey}`;
}


async depositMoney(ctx, org, userId, amount) {
  this._logInvocation("depositMoney", arguments, ctx);
  this._requireOrg(ctx, 'BankMSP'); // caller must be bank

  const txId = ctx.stub.getTxID();
  const ts = await this._simNowISO(ctx);


  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    throw new Error(`Invalid deposit amount: ${amount}`);
  }

  const key = this._walletTxKey(ctx, org, userId, txId, 'DEPOSIT');
  const wid = this._walletId(org, userId);

  const entry = {
    docType: 'walletTx',
    walletId: wid,
    org, userId,
    kind: 'DEPOSIT',
    delta: amt,           // signed amount (+)
    ts, txId
  };

  await ctx.stub.putState(key, Buffer.from(JSON.stringify(entry)));

  const newBal = await this._computeWalletBalance(ctx, org, userId);
  return JSON.stringify({
    ok: true,
    txId,
    walletId: wid,
    amount: amt,
    balance: newBal,
    ts
  });
}

// === Wallet helpers (put near top of your contract class) ===
_walletId(org, userId) {
  return `${String(org)}-${String(userId)}-wallet`;
}

/** walletTx composite key builder:
 *  - prefix by org + userId to match the balance scanner’s partial key
 *  - include txId and a suffix ('DEBIT'/'CREDIT') for uniqueness/readability
 */
_walletTxKey(ctx, org, userId, txId, suffix) {
  return ctx.stub.createCompositeKey('walletTx', [
    String(org), String(userId), String(txId), String(suffix)
  ]);
}

/** Numeric balance reducer used internally (no JSON wrapping) */
async _computeWalletBalance(ctx, org, userId) {
  const iter = await ctx.stub.getStateByPartialCompositeKey('walletTx', [String(org), String(userId)]);
  let total = 0;

  try {
    while (true) {
      const res = await iter.next();              // ← pull one record
      if (res.value) {
        // In Fabric, res.value is usually { key, value: Buffer }
        const buf = res.value.value ? res.value.value : res.value; // handle both shapes
        const rec = JSON.parse(buf.toString());

        // Support both schemas: delta (±) or amount (+) with type
        if (typeof rec.delta !== 'undefined') {
          const v = Number(rec.delta);
          if (Number.isFinite(v)) total += v;
        } else {
          const v = Number(rec.amount);
          const t = String(rec.type || '').toUpperCase();
          if (Number.isFinite(v)) {
            if (t === 'CREDIT' || t === 'TRANSFER_IN' || t === 'DEPOSIT') total += v;
            else if (t === 'DEBIT' || t === 'TRANSFER_OUT' || t === 'WITHDRAW') total -= v;
          }
        }
      }
      if (res.done) break;
    }
  } finally {
    await iter.close();
  }
  return total;
}

// In cardamom_11.js (contract class)

async getWalletBalance(ctx, org, userId) {
  // basic validation
  if (!org || !userId) {
    throw new Error('org and userId are required');
  }

  // compute numeric balance from walletTx logs
  const balance = await this._computeWalletBalance(ctx, String(org), String(userId));

  // optional ISO timestamp helper (use your existing _simNowISO(ctx) if present)
  const ts = this._simNowISO ? await this._simNowISO(ctx) : new Date().toISOString();

  // respond as JSON string (evaluateTransaction caller expects a JSON string)
  return JSON.stringify({
    balance
  });
}


// public wrapper (call this from your API)
async transferMoney(ctx, fromOrg, fromUserId, toOrg, toUserId, amount) {
  // optional: access control here
  return await this._transfer(ctx, fromOrg, fromUserId, toOrg, toUserId, amount);
}

// internal
async _transfer(ctx, fromOrg, fromUserId, toOrg, toUserId, amount) {
  const txId = ctx.stub.getTxID();
  const ts = this._simNowISO? await this._simNowISO(ctx) : new Date().toISOString();

  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error(`Invalid transfer amount: ${amount}`);

  // Check funds
  const fromBal = await this._computeWalletBalance(ctx, fromOrg, fromUserId);
  if (fromBal < amt) throw new Error(`❌ Insufficient balance: ${fromBal} < ${amt}`);

  // Keys (SAME prefix shape as deposits!)
  const debitKey  = this._walletTxKey(ctx, fromOrg, fromUserId, txId,'DEBIT');
  const creditKey = this._walletTxKey(ctx, toOrg,   toUserId,   txId,'CREDIT');

  // Bodies (signed deltas)
  const fromWid = this._walletId(fromOrg, fromUserId);
  const toWid   = this._walletId(toOrg, toUserId);

  const debit =  {
    docType: 'walletTx',
    type: 'TRANSFER_OUT',
    walletId: fromWid,
    org: fromOrg, userId: fromUserId,
    counterparty: toWid,
    delta: -amt,
    ts, txId
  };
  const credit = {
    docType: 'walletTx',
    type: 'TRANSFER_IN',
    walletId: toWid,
    org: toOrg, userId: toUserId,
    counterparty: fromWid,
    delta: +amt,
    ts, txId
  };

  await ctx.stub.putState(debitKey,  Buffer.from(JSON.stringify(debit)));
  await ctx.stub.putState(creditKey, Buffer.from(JSON.stringify(credit)));

  // Return updated balances (optional)
  const toBalAfter = await this._computeWalletBalance(ctx, toOrg, toUserId);
  return JSON.stringify({
    ok: true,
    txId,
    amount: amt,
    from: { org: fromOrg, userId: fromUserId, newBalance: fromBal - amt },
    to:   { org: toOrg,   userId: toUserId,   newBalance: toBalAfter },
    ts
  });
}



  // ====================== PRODUCE ======================
 async submitProduce(ctx, lotId, farmerId, weightKg, lotDate, bags, auctioncenterId) {
  this._logInvocation("submitProduce", arguments, ctx);
  this._requireOrg(ctx, 'FarmersMSP');

  // ---- Validate basics
  if (!lotId || !farmerId || !weightKg || !lotDate || !bags || !auctioncenterId) {
    throw new Error('lotId, farmerId, weightKg, lotDate, bags, auctioncenterId are required');
  }

  const weightNum = Number(weightKg);
  const bagsInt   = parseInt(bags, 10);
  if (!Number.isFinite(weightNum) || weightNum <= 0) throw new Error(`Invalid weightKg: ${weightKg}`);
  if (!Number.isInteger(bagsInt) || bagsInt <= 0)   throw new Error(`Invalid bags: ${bags}`);

  // ---- Get testing fee for this auction center
  const feeKey  = ctx.stub.createCompositeKey('testingFee', [String(auctioncenterId)]);
  const feeData = await ctx.stub.getState(feeKey);
  if (!feeData?.length) {
    throw new Error(`❌ Auctioncenter fee not set for ID ${auctioncenterId}`);
  }

  let feeAmt;
  try {
    const feeObj = JSON.parse(feeData.toString());
    feeAmt = Number(feeObj.feeAmount);
    if (!Number.isFinite(feeAmt) || feeAmt < 0) {
      throw new Error(`feeAmount must be a non-negative number (got ${feeObj.feeAmount})`);
    }
  } catch (err) {
    throw new Error(`❌ Failed to parse testing fee for ${auctioncenterId}: ${err.message}`);
  }

  // ---- Charge the farmer → pay the auction center
  // NOTE: org names MUST be strings that match your wallet/scan prefixes
  await this._transfer(ctx, 'farmers', String(farmerId), 'auctioncenters', String(auctioncenterId), String(feeAmt));

  // ---- Persist lot
  const lot = {
    docType: 'lot',
    lotId: String(lotId),
    farmerId: String(farmerId),
    ownerId: String(farmerId),
    weightKg: weightNum,
    lotDate: String(lotDate),
    bags: bagsInt,
    auctioncenterId: String(auctioncenterId),
    status: 'SUBMITTED',
    submittedAt: this._simNowISO ? await this._simNowISO(ctx) : new Date().toISOString(),
    testingFee: feeAmt,
    offers: []
  };

  const lotKey = ctx.stub.createCompositeKey('lot', [String(lotId)]);
  await ctx.stub.putState(lotKey, Buffer.from(JSON.stringify(lot)));

  return JSON.stringify({ ok: true, lotId: String(lotId), testingFee: feeAmt });
}

  async testCardamom(ctx, lotId, result, videoHash, gradingJson) {
    this._logInvocation("testCardamom", arguments, ctx);
    console.log("🚀 Function `testCardamom` invoked");
  this._requireOrg(ctx, 'AuctioncentersMSP');

  const lotKey = ctx.stub.createCompositeKey('lot', [lotId]);
  const lotBytes = await ctx.stub.getState(lotKey);
  if (!lotBytes || lotBytes.length === 0) throw new Error('Lot not found');

  const lot = JSON.parse(lotBytes.toString());

  // Basic test info
  lot.status = result === 'pass' ? 'APPROVED' : 'REJECTED';
  lot.testResult = result;
  lot.testedAt = await this._simNowISO(ctx);

  lot.videoHash = videoHash;

  // Optional grading details
  if (gradingJson) {
    const grading = JSON.parse(gradingJson);

    // Validate sizeGrades
    if (!grading.sizeGrades || typeof grading.sizeGrades !== 'object') {
      throw new Error("Missing or invalid 'sizeGrades' field in grading data");
    }

    // Optionally validate size ranges and required fields
    for (const [size, breakdown] of Object.entries(grading.sizeGrades)) {
      const { clean, sick, split, total } = breakdown;
      if (
        clean === undefined ||
        sick === undefined ||
        split === undefined ||
        total === undefined
      ) {
        throw new Error(`Missing grading fields for size category: ${size}`);
      }
    }

    // Validate quality and metric fields
    const requiredQuality = ['greenPercent', 'averagePercent', 'fruitPercent', 'belowAveragePercent'];
    const requiredMetrics = ['literWeight', 'moisture', 'numberOfBags', 'netWeight'];

    for (const field of requiredQuality) {
      if (grading[field] === undefined) {
        throw new Error(`Missing quality field: ${field}`);
      }
    }

    for (const field of requiredMetrics) {
      if (grading[field] === undefined) {
        throw new Error(`Missing metric field: ${field}`);
      }
    }

    // Assign grading data to the lot
    lot.grading = {
      sizeGrades: grading.sizeGrades,
      quality: {
        greenPercent: grading.greenPercent,
        averagePercent: grading.averagePercent,
        fruitPercent: grading.fruitPercent,
        belowAveragePercent: grading.belowAveragePercent,
      },
      metrics: {
        literWeight: grading.literWeight,
        moisture: grading.moisture,
        numberOfBags: grading.numberOfBags,
        netWeight: grading.netWeight,
      }
    };
  }

  await ctx.stub.putState(lotKey, Buffer.from(JSON.stringify(lot)));
  return `Lot ${lotId} tested as ${lot.status}${gradingJson ? ' with grading details' : ''}`;
}


// ================== FINANCIER TERMS REGISTRY ==================

/**
 * Create a finance request based on a financier's active terms.
 * Requester can be a Farmer or Wholesaler (extend as needed).
 * Not tied to a lot; you can optionally pass a reference like PO/Invoice/Lot later.
 *
 * @param {Context} ctx
 * @param {string} financierId - e.g., "financierA" (the CA userId of financier)
 * @param {string|number} principalAmount - amount requested (use smallest unit or a decimal string)
 * @param {string} currency - e.g., "INR"
 * @param {string|number} tenorDaysOverride - optional; if provided overrides terms.tenorDays
 * @param {string} refType - optional; e.g., "PO", "INVOICE", "LOT"
 * @param {string} refId - optional; your external reference id
 */
/**
 * Create a finance request for a specific lot using a financier's active terms.
 * - Principal = current highest offer (totalAmount) for the lot
 * - Requester must be the current highest bidder
 * - tenorDays must be <= financier terms.tenorDays
 * - Keyed by (lotId, bidderId) to prevent duplicates for same winner/lot
 *
 * @param {Context} ctx
 * @param {string} financierId
 * @param {string} lotId
 * @param {string|number} tenorDaysOverride - optional; must be <= terms.tenorDays
 */

// ====================== FINANCE ======================


// ===================== EGT HELPERS & PARAMS ===============================

// ========= Per-Financier Finance Policy (EGT mapping) =========


_financePolicyKey(finId) {
  return this.ctx ? this.ctx.stub.createCompositeKey('finPolicy', [String(finId)]) // if you keep ctx on this
                  : null;
}

// Defaults used if a financier hasn't set a custom policy
_defaultFinancePolicy() {
  return {
    roundMoney: 2,

    // ---- FEE (immutable) ----
    feePct: 1.0, // 1% fixed, not tunable via policy

    // ---- Score interpolation endpoints (tenor/LTV only) ----
    tenorAtS0: 45,    // days
    tenorAtS1: 400,   // days
    ltvAtS0: 60,      // %
    ltvAtS1: 100,     // %
    tenor: 365,
    // ---- Penalty guardrails ----
    penaltyMinPct: 0.0,
    penaltyMaxPct: 100.0,
    penaltyBasePct: 3.0,
    penalty: 3.0, // alias of penaltyBasePct for backward compatibility

    // ---- Hard clamps ----
    minTenorDays: 7,   maxTenorDays: 480,
    minLtvPct: 0,      maxLtvPct: 100,

    // ---- APR guardrails + composition ----
    minAPR: 0.06,
    maxAPR: 0.48,
    baseAPR: 0.18,
    spreadMax: 0.18
  };
}

_aprPctFromInput(v, label = 'APR') {
  const raw = Number(v);
  if (!Number.isFinite(raw) || raw <= 0) throw new Error(`${label} must be a positive number`);
  const pct = raw <= 1 ? raw * 100 : raw;
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
    throw new Error(`${label} must be between 0 and 100 percent`);
  }
  return Number(pct.toFixed(2));
}

_aprRateFromInput(v, label = 'APR') {
  return Number((this._aprPctFromInput(v, label) / 100).toFixed(6));
}

async _getFinanceOffer(ctx, wholesalerId, financierId) {
  const key = ctx.stub.createCompositeKey('finOffer', [String(wholesalerId), String(financierId)]);
  const b = await ctx.stub.getState(key);
  return b?.length ? JSON.parse(b.toString()) : null;
}

async _listKnownFinancierIds(ctx) {
  const ids = new Set();

  const policyIter = await ctx.stub.getStateByPartialCompositeKey('finPolicy', []);
  const policyRows = await this._drainIteratorKV(policyIter);
  for (const row of policyRows) {
    try {
      const parts = ctx.stub.splitCompositeKey(row.key).attributes;
      if (parts?.[0]) ids.add(String(parts[0]));
    } catch {}
  }

  const reqIter = await ctx.stub.getStateByPartialCompositeKey('financeReq', []);
  const reqRows = await this._drainIteratorKV(reqIter);
  for (const row of reqRows) {
    try {
      const fr = JSON.parse(row.value);
      if (fr?.financierId) ids.add(String(fr.financierId));
    } catch {}
  }

  const walletIter = await ctx.stub.getStateByPartialCompositeKey('walletTx', ['financiers']);
  const walletRows = await this._drainIteratorKV(walletIter);
  for (const row of walletRows) {
    try {
      const parts = ctx.stub.splitCompositeKey(row.key).attributes;
      if (parts?.[1]) ids.add(String(parts[1]));
    } catch {}
  }

  return Array.from(ids).sort();
}

async _getFinancierLedgerStats(ctx, financierId, wholesalerId = '') {
  const finId = String(financierId);
  const whId = String(wholesalerId || '');
  const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const stats = {
    financierId: finId,
    wholesalerId: whId || null,
    loans: 0,
    wholesalerLoans: 0,
    activeLoans: 0,
    overdueLoans: 0,
    totalPrincipal: 0,
    activeOutstanding: 0,
    totalRepaid: 0,
    totalInterest: 0,
    aprSum: 0,
    financierProfitSum: 0,
    wholesalerProfitSum: 0
  };

  const iter = await ctx.stub.getStateByPartialCompositeKey('financeReq', []);
  const rows = await this._drainIteratorKV(iter);
  for (const row of rows) {
    let fr;
    try { fr = JSON.parse(row.value); } catch { continue; }
    if (String(fr?.financierId || '') !== finId) continue;

    const principal = n(fr?.principalAmount);
    const outstanding = n(fr?.outstanding);
    const repaid = n(fr?.repaidAmt);
    const status = String(fr?.status || '').toUpperCase();

    stats.loans += 1;
    stats.totalPrincipal += principal;
    stats.activeOutstanding += outstanding;
    stats.totalRepaid += repaid;
    stats.totalInterest += n(fr?.computed?.interestAmt);
    stats.aprSum += n(fr?.pricing?.annualInterestPct);
    stats.financierProfitSum += n(fr?.financierprofitpercent ?? fr?.financierprofit);
    stats.wholesalerProfitSum += n(fr?.wholesalerprofitpercent ?? fr?.wholesalerprofit);
    if (!['REPAID', 'CLOSED', 'REJECTED'].includes(status)) stats.activeLoans += 1;
    if (n(fr?.overdue) > 0) stats.overdueLoans += 1;
    if (whId && String(fr?.requesterId || '') === whId) stats.wholesalerLoans += 1;
  }

  let walletBalance = 0;
  try { walletBalance = await this._computeWalletBalance(ctx, 'financiers', finId); } catch {}

  stats.walletBalance = walletBalance;
  stats.avgAprPct = stats.loans ? Number((stats.aprSum / stats.loans).toFixed(2)) : 0;
  stats.avgFinancierProfitPct = stats.loans ? Number((stats.financierProfitSum / stats.loans).toFixed(4)) : 0;
  stats.avgWholesalerProfitPct = stats.loans ? Number((stats.wholesalerProfitSum / stats.loans).toFixed(4)) : 0;
  stats.overdueRate = stats.loans ? Number((stats.overdueLoans / stats.loans).toFixed(4)) : 0;
  stats.utilization = (walletBalance + stats.activeOutstanding) > 0
    ? Number((stats.activeOutstanding / (walletBalance + stats.activeOutstanding)).toFixed(4))
    : 0;
  stats.walletRatio = (walletBalance + stats.activeOutstanding) > 0
    ? Number((walletBalance / (walletBalance + stats.activeOutstanding)).toFixed(4))
    : 1;
  return stats;
}

async _buildAutoRLOffer(ctx, wholesalerId, financierId, principalAmount = '', tenorDaysRequested = '') {
  const policy = await this._getFinancePolicyFor(ctx, financierId, 'false');
  const terms = this._termsFromScore(policy, 0.5);
  const stats = await this._getFinancierLedgerStats(ctx, financierId, wholesalerId);
  const actions = [6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36];
  const minPct = this._aprPctFromInput(policy.minAPR ?? 0.06, 'min APR');
  const maxPct = this._aprPctFromInput(policy.maxAPR ?? 0.48, 'max APR');
  const basePct = this._aprPctFromInput(policy.baseAPR ?? terms.aprPct ?? 18, 'base APR');

  let target = basePct;
  const payoff = stats.avgFinancierProfitPct;
  const utilization = stats.utilization;
  const walletRatio = stats.walletRatio;

  if (utilization > 0.85 || walletRatio < 0.15) target += 4;
  else if (utilization > 0.65) target += 2;
  else if (utilization < 0.35 && walletRatio > 0.45) target -= 2;

  if (payoff < 0) target += 4;
  else if (payoff < 3 && stats.loans > 0) target += 2;
  else if (payoff > 12 && utilization < 0.75) target -= 2;

  if (stats.overdueRate > 0.3) target += 2;
  if (stats.wholesalerLoans > 0 && stats.avgWholesalerProfitPct < 0) target -= 2;

  target = Math.min(maxPct, Math.max(minPct, target));
  const allowedActions = actions.filter(a => a >= minPct && a <= maxPct);
  const actionSet = allowedActions.length ? allowedActions : [target];
  const aprPct = Number(actionSet.reduce((best, a) => Math.abs(a - target) < Math.abs(best - target) ? a : best, actionSet[0]).toFixed(2));
  const tenorReq = Number(tenorDaysRequested || 0);
  const tenorDays = Number.isFinite(tenorReq) && tenorReq > 0
    ? Math.min(tenorReq, Number(terms.tenorDays || tenorReq))
    : Number(terms.tenorDays);

  const offer = {
    docType: 'finOffer',
    wholesalerId: String(wholesalerId),
    financierId: String(financierId),
    aprPct,
    baseAprPct: basePct,
    feePct: Number(terms.feePct ?? 1.0),
    penaltyPct: Number(terms.penaltyPct ?? 0),
    tenorDays,
    ltvCapPct: Number(terms.ltvPct ?? 0),
    source: 'AUTO_RL',
    rl: {
      modelVersion: 'ledger-auto-rl-v1',
      action: `direct_apr_${aprPct}`,
      state: {
        utilizationBucket: utilization > 0.75 ? 'HIGH' : utilization > 0.4 ? 'MID' : 'LOW',
        walletRatioBucket: walletRatio < 0.2 ? 'LOW' : walletRatio < 0.5 ? 'MID' : 'HIGH',
        payoffBucket: payoff < 0 ? 'LOSS' : payoff < 5 ? 'LOW' : payoff < 12 ? 'MID' : 'HIGH',
        overdueRate: stats.overdueRate
      },
      targetAprPct: Number(target.toFixed(2)),
      stats
    },
    updatedAt: await this._nowISO(ctx)
  };

  const principal = Number(principalAmount || 0);
  if (Number.isFinite(principal) && principal > 0 && Number.isFinite(tenorDays) && tenorDays > 0) {
    const feeAmt = this._round(principal * (offer.feePct / 100), 2);
    const interestAmt = this._round(principal * (aprPct / 100) * (tenorDays / 365), 2);
    offer.pricing = {
      principalAmount: principal,
      feeAmt,
      interestAmt,
      totalPayable: this._round(principal + feeAmt + interestAmt, 2)
    };
  }

  return offer;
}


// Replace your existing function with this version
// Private helper used by your public getter getFinancePolicyFor(...)
async _getFinancePolicyFor(ctx, financierId, adjustWithFinScore = 'true') {
  const key = ctx.stub.createCompositeKey('finPolicy', [String(financierId)]);
  const buf = await ctx.stub.getState(key);

  // ---- Default policy ----
  const _def = (typeof this._defaultFinancePolicy === 'function'
    ? this._defaultFinancePolicy()
    : {
        roundMoney: 2,
        tenor:365,
        minTenorDays: 7,  maxTenorDays: 600,
        tenorAtS0: 45,    tenorAtS1: 320,
        minLtvPct: 0,     maxLtvPct: 100,
        ltvAtS0: 60,      ltvAtS1: 85,
        minAPR: 0.06,     maxAPR: 0.36,
        baseAPR: 0.12,    spreadMax: 0.18,
        penaltyMinPct: 0, penaltyMaxPct: 10,
        feePct: 1.0
      });

  // ---- Merge stored (if any) ----
  let stored = null;
  if (buf?.length) {
    try { stored = JSON.parse(buf.toString()); } catch { stored = null; }
  }
  const raw = { ..._def, ...(stored || {}) };

  // ---- Helpers ----
  const num = (v, fb) => (Number.isFinite(Number(v)) ? Number(v) : fb);
  const iz  = (v, fb) => (Number.isFinite(Number(v)) ? Math.floor(Number(v)) : fb);
  const clamp = (x, lo, hi) => Math.min(num(hi, hi), Math.max(num(lo, lo), num(x, lo)));
  const rate = (v, fb) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fb;
    return Math.abs(n) > 1 ? n / 100 : n;
  };

  const p = { ...raw };
  p.feePct = 1.0; // invariant
  p.minAPR = rate(p.minAPR, _def.minAPR);
  p.maxAPR = Math.max(p.minAPR, rate(p.maxAPR, _def.maxAPR));
  p.baseAPR = clamp(rate(p.baseAPR, _def.baseAPR), p.minAPR, p.maxAPR);

  // ---- Get financier score sF ∈ [0,1] ----
  let sF = 0.5;
  const wantAdjust = String(adjustWithFinScore).toLowerCase() === 'true';
  if (wantAdjust) {
    try {
      if (typeof this._getFinScore === 'function') {
        const rec = await this._getFinScore(ctx, String(financierId));
        const s = Number(rec?.s);
        sF = Number.isFinite(s) ? Math.max(0, Math.min(1, s)) : 0.5;
      }
    } catch { /* keep default 0.5 */ }
  }

  // ============ 🧮 SCORE-WEIGHTED INTERPOLATION =============

  // baseAPR → smaller for higher score
  if (wantAdjust) {
    p.baseAPR = sF * p.minAPR + (1 - sF) * p.maxAPR;

  // LTV (loan-to-value) → higher for higher score
    p.ltv = sF * p.maxLtvPct + (1 - sF) * p.minLtvPct;

  // Penalty percentage → lower for higher score
    p.penaltyBasePct = sF * p.penaltyMinPct + (1 - sF) * p.penaltyMaxPct;
    p.penalty = p.penaltyBasePct; // alias for backward compatibility

  // Tenor → longer for higher score
    p.tenor = sF * p.maxTenorDays + (1 - sF) * p.minTenorDays;
  } else {
    p.ltv = num(p.ltv, num(p.ltvAtS1, p.maxLtvPct));
    p.penaltyBasePct = num(p.penaltyBasePct, num(p.penalty, 3.0));
    p.penalty = p.penaltyBasePct;
    p.tenor = num(p.tenor, _def.tenor);
  }

  // Optional rounding & clamping
  p.baseAPR   = clamp(p.baseAPR, p.minAPR, p.maxAPR);
  p.ltv   = clamp(p.ltv, p.minLtvPct, p.maxLtvPct);
  p.penalty   = clamp(p.penalty, p.penaltyMinPct, p.penaltyMaxPct);
  p.tenor = clamp(p.tenor , p.minTenorDays, p.maxTenorDays);

  // Return final policy
  return p;
}



// Financier sets their own policy; admin of FinanciersMSP can optionally set for others
async setFinancePolicyForFinancier(ctx, finIdOrEmpty, json) {
  this._requireOrg(ctx, 'FinanciersMSP');

  const caller = this._userId ? this._userId(ctx) : 'unknown';
  const finId  = String(finIdOrEmpty || caller);

  const incoming = JSON.parse(String(json || '{}'));
  const current  = await this._getFinancePolicyFor(ctx, finId);
  const merged   = { ...current, ...incoming };

  // helpers
  const n  = (v, fb) => (Number.isFinite(Number(v)) ? Number(v) : fb);
  const iz = (v, fb) => Number.isFinite(Number(v)) ? Math.floor(Number(v)) : fb;
  const clamp = (x, lo, hi) => Math.min(Number(hi), Math.max(Number(lo), Number(x)));

  // general
  merged.roundMoney = Math.max(0, iz(merged.roundMoney, current.roundMoney));

  // ---- FEE: IMMUTABLE 1.0% ----
  merged.feePct = 1.0; // ignore any incoming fee fields

  // ---- PENALTY controls (min / max / base; 'penalty' is alias for base) ----
  const inMin  = n(merged.penaltyMinPct, current.penaltyMinPct);
  const inMax  = n(merged.penaltyMaxPct, current.penaltyMaxPct);
  const inBase = n(
    merged.penaltyBasePct !== undefined ? merged.penaltyBasePct : merged.penalty,
    current.penaltyBasePct !== undefined ? current.penaltyBasePct : current.penalty
  );

  merged.penaltyMinPct  = clamp(inMin, 0, 100);
  merged.penaltyMaxPct  = clamp(Math.max(merged.penaltyMinPct, inMax), 0, 100);
  merged.penaltyBasePct = clamp(inBase, merged.penaltyMinPct, merged.penaltyMaxPct);
  merged.penalty        = merged.penaltyBasePct; // keep alias in sync
  merged.tenor       = merged.tenor;
  // ---- Tenor / LTV (score-based interpolation endpoints + clamps) ----
  merged.minTenorDays = Math.max(1, iz(merged.minTenorDays, current.minTenorDays));
  merged.maxTenorDays = Math.max(merged.minTenorDays, iz(merged.maxTenorDays, current.maxTenorDays));
  merged.minLtvPct    = Math.max(0, n(merged.minLtvPct, current.minLtvPct));
  merged.maxLtvPct    = Math.min(100, Math.max(merged.minLtvPct, n(merged.maxLtvPct, current.maxLtvPct)));

  merged.tenorAtS0    = Math.max(1, iz(merged.tenorAtS0, current.tenorAtS0));
  merged.tenorAtS1    = Math.max(merged.tenorAtS0, iz(merged.tenorAtS1, current.tenorAtS1));
  merged.ltvAtS0      = clamp(n(merged.ltvAtS0, current.ltvAtS0), merged.minLtvPct, merged.maxLtvPct);
  merged.ltvAtS1      = clamp(n(merged.ltvAtS1, current.ltvAtS1), merged.minLtvPct, merged.maxLtvPct);
  

  if (merged.tenor !== undefined) {
  const tVal = n(merged.tenor, current.tenor ?? merged.minTenorDays);
  merged.tenor = clamp(tVal, merged.minTenorDays, merged.maxTenorDays);
  } else {
    // If tenor not directly given, derive it from midpoint of range
    merged.tenor = Math.round((merged.minTenorDays + merged.maxTenorDays) / 2);
  }
  // ---- APR guardrails ----
  merged.minAPR    = n(merged.minAPR, current.minAPR);
  merged.maxAPR    = Math.max(merged.minAPR, n(merged.maxAPR, current.maxAPR));
  merged.baseAPR   = n(merged.baseAPR, current.baseAPR);
  merged.spreadMax = Math.max(0, n(merged.spreadMax, current.spreadMax));

  const key = ctx.stub.createCompositeKey('finPolicy', [String(finId)]);
  await ctx.stub.putState(key, Buffer.from(JSON.stringify(merged)));
  await ctx.stub.setEvent('FinancePolicyUpdated', Buffer.from(JSON.stringify({ financierId: finId, policy: merged })));
  return JSON.stringify({ ok: true, financierId: finId, policy: merged });
}

async updateFinancierRLOffer(ctx, wholesalerId, json, finIdOrEmpty = '') {
  this._logInvocation("updateFinancierRLOffer", arguments, ctx);
  this._requireOrg(ctx, 'FinanciersMSP');

  const financierId = String(finIdOrEmpty || (this._userId ? this._userId(ctx) : 'unknown')).trim();
  const whId = String(wholesalerId || '').trim();
  if (!financierId) throw new Error('financierId required');
  if (!whId) throw new Error('wholesalerId required');

  const incoming = JSON.parse(String(json || '{}'));
  const aprInput = incoming.aprPct ?? incoming.offeredAprPct ?? incoming.offeredAPR ?? incoming.apr;
  if (aprInput === undefined || aprInput === null || String(aprInput).trim() === '') {
    throw new Error('RL offer must include aprPct');
  }

  const offeredAprPct = this._aprPctFromInput(aprInput, 'offered APR');
  const baseAprInput = incoming.baseAPR ?? incoming.baseAprPct ?? incoming.baseApr ?? incoming.base_apr;
  const baseAPR = baseAprInput !== undefined && baseAprInput !== null && String(baseAprInput).trim() !== ''
    ? this._aprRateFromInput(baseAprInput, 'base APR')
    : Number((offeredAprPct / 100).toFixed(6));

  const policyKey = ctx.stub.createCompositeKey('finPolicy', [financierId]);
  const currentBytes = await ctx.stub.getState(policyKey);
  let current = this._defaultFinancePolicy();
  if (currentBytes?.length) {
    try { current = { ...current, ...JSON.parse(currentBytes.toString()) }; } catch {}
  }

  const minAPR = incoming.minAPR !== undefined ? this._aprRateFromInput(incoming.minAPR, 'min APR') : Number(current.minAPR ?? 0.06);
  const maxAPR = incoming.maxAPR !== undefined ? this._aprRateFromInput(incoming.maxAPR, 'max APR') : Number(current.maxAPR ?? 0.48);
  const mergedPolicy = {
    ...current,
    minAPR,
    maxAPR: Math.max(minAPR, maxAPR),
    baseAPR: Math.min(Math.max(baseAPR, minAPR), Math.max(minAPR, maxAPR)),
    rlUpdatedAt: await this._nowISO(ctx),
    rlModelVersion: incoming.modelVersion ?? incoming.rlModelVersion ?? current.rlModelVersion ?? null
  };

  if (incoming.tenorDays !== undefined || incoming.tenor !== undefined) {
    mergedPolicy.tenor = Number(incoming.tenorDays ?? incoming.tenor);
  }
  if (incoming.ltvPct !== undefined || incoming.ltv !== undefined) {
    mergedPolicy.ltv = Number(incoming.ltvPct ?? incoming.ltv);
  }
  if (incoming.penaltyPct !== undefined || incoming.penaltyBasePct !== undefined) {
    mergedPolicy.penaltyBasePct = Number(incoming.penaltyBasePct ?? incoming.penaltyPct);
    mergedPolicy.penalty = mergedPolicy.penaltyBasePct;
  }

  await ctx.stub.putState(policyKey, Buffer.from(JSON.stringify(mergedPolicy)));

  const policy = await this._getFinancePolicyFor(ctx, financierId, 'false');
  const score = 0.5;
  const terms = this._termsFromScore(policy, score);
  const offer = {
    docType: 'finOffer',
    wholesalerId: whId,
    financierId,
    aprPct: offeredAprPct,
    baseAprPct: this._aprPctFromInput(mergedPolicy.baseAPR, 'base APR'),
    feePct: Number(terms.feePct ?? 1.0),
    penaltyPct: Number(terms.penaltyPct ?? 0),
    tenorDays: Number(incoming.tenorDays ?? incoming.tenor ?? terms.tenorDays),
    ltvCapPct: Number(incoming.ltvPct ?? incoming.ltv ?? terms.ltvPct),
    source: 'RL',
    rl: {
      action: incoming.action ?? null,
      state: incoming.state ?? null,
      reward: incoming.reward ?? null,
      modelVersion: incoming.modelVersion ?? incoming.rlModelVersion ?? null
    },
    updatedAt: mergedPolicy.rlUpdatedAt
  };

  const offerKey = ctx.stub.createCompositeKey('finOffer', [whId, financierId]);
  await ctx.stub.putState(offerKey, Buffer.from(JSON.stringify(offer)));
  await ctx.stub.setEvent('FinancierRLOfferUpdated', Buffer.from(JSON.stringify({ wholesalerId: whId, financierId, offer })));
  return JSON.stringify({ ok: true, financierId, wholesalerId: whId, policy: mergedPolicy, offer });
}

async refreshFinancierRLOfferFromLedger(ctx, wholesalerId, principalAmount = '', tenorDaysRequested = '', finIdOrEmpty = '') {
  this._logInvocation("refreshFinancierRLOfferFromLedger", arguments, ctx);
  this._requireOrg(ctx, 'FinanciersMSP');

  const financierId = String(finIdOrEmpty || (this._userId ? this._userId(ctx) : 'unknown')).trim();
  const whId = String(wholesalerId || '').trim();
  if (!financierId) throw new Error('financierId required');
  if (!whId) throw new Error('wholesalerId required');

  const offer = await this._buildAutoRLOffer(ctx, whId, financierId, principalAmount, tenorDaysRequested);
  const policyKey = ctx.stub.createCompositeKey('finPolicy', [financierId]);
  const b = await ctx.stub.getState(policyKey);
  let policy = this._defaultFinancePolicy();
  if (b?.length) {
    try { policy = { ...policy, ...JSON.parse(b.toString()) }; } catch {}
  }

  policy.baseAPR = Number((Number(offer.aprPct) / 100).toFixed(6));
  policy.rlUpdatedAt = offer.updatedAt;
  policy.rlModelVersion = offer.rl?.modelVersion || 'ledger-auto-rl-v1';
  await ctx.stub.putState(policyKey, Buffer.from(JSON.stringify(policy)));

  const offerKey = ctx.stub.createCompositeKey('finOffer', [whId, financierId]);
  await ctx.stub.putState(offerKey, Buffer.from(JSON.stringify(offer)));
  await ctx.stub.setEvent('FinancierRLOfferUpdated', Buffer.from(JSON.stringify({ wholesalerId: whId, financierId, offer })));
  return JSON.stringify({ ok: true, financierId, wholesalerId: whId, policy, offer });
}

// Public read
// Chaincode-invokable public method
async getFinancePolicyFor(ctx, financierId, adjust = 'true') {
  const eff = await this._getFinancePolicyFor(ctx, financierId, adjust);
  return JSON.stringify(eff);
}


// Optional: list all (admin)
async listFinancePolicies(ctx) {
  this._requireOrg(ctx, 'FinanciersMSP');
  const iter = await ctx.stub.getStateByPartialCompositeKey('finPolicy', []);
  const out = [];
  for (let r = await iter.next(); !r.done; r = await iter.next()) {
    const obj = JSON.parse(r.value.value.toString());
    // financierId derivable from composite key if you want to add it here
    out.push(obj);
  }
  await iter.close();
  return JSON.stringify(out);
}





// Time helper (respects your SIM clock if present)
async _nowISO(ctx) {
  if (typeof this._simNowISO === 'function') {
    return await this._simNowISO(ctx);
  }
  return new Date().toISOString();
}
async _daysBetween(aIso, bIso) {
  const a = Date.parse(aIso), b = Date.parse(bIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.floor((b - a) / (24*3600*1000));
}

async _getEGTParams(ctx) {
  const b = await ctx.stub.getState('egt:params');
  if (b?.length) return JSON.parse(b.toString());
  return {
    baseAPR: 0.18,        // 18%
    spreadMax: 0.18,      // +0..18% risk spread
    eta: 0.5,             // learning rate
    w_on: 1.0, w_late: 0.7, w_def: 1.5, w_days: 0.6,
    baselineAlpha: 0.1,
    minAPR: 0.06,         // clamps (optional)
    maxAPR: 0.48
  };
}
async _putEGTParams(ctx, params) {
  this._requireOrg(ctx, 'FinanciersMSP');
  await ctx.stub.putState('egt:params', Buffer.from(JSON.stringify(params)));
  return 'OK';
}
async _getBaseline(ctx) {
  const b = await ctx.stub.getState('egt:baseline');
  return b?.length ? Number(b.toString()) : 0;
}
async _setBaseline(ctx, v) {
  await ctx.stub.putState('egt:baseline', Buffer.from(String(v)));
}
_scoreKey(whId) { return `egt:score:${whId}`; }
async _getScore(ctx, whId) {
  const b = await ctx.stub.getState(this._scoreKey(whId));
  return b?.length ? JSON.parse(b.toString()) : { s: 0.5, n: 0, lastAt: '' };
}
async _setScore(ctx, whId, rec) {
  await ctx.stub.putState(this._scoreKey(whId), Buffer.from(JSON.stringify(rec)));
}
_logit(x) {
  const eps = 1e-9, xx = Math.min(1 - eps, Math.max(eps, Number(x)));
  return Math.log(xx / (1 - xx));
}
_sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
_clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// ===================== PUBLIC: GET WHOLESALER EGT SCORE =====================
// In SupplyChainContract
async getWholesalerScore(ctx, wholesalerId) {
  this._logInvocation("getWholesalerScore", arguments, ctx);

  if (!wholesalerId) throw new Error("wholesalerId is required");

  // Try to reconcile before fetching to keep score fresh
  try {
    await this.updateScoresAllFinanceRequests(ctx);
  } catch (e) {
    console.warn("[getWholesalerScore] reconcile failed:", e.message);
  }

  // Fetch current score record
  const rec = await this._getScore(ctx, String(wholesalerId));

  // Fetch latest 25 history entries (you can adjust limit)
  const historyLimit = 25;
  const history = await this._readEGTHistory(ctx, String(wholesalerId), '', historyLimit);

  // Return combined result
  return JSON.stringify({
    wholesalerId: String(wholesalerId),
    score: rec?.s ?? 0.5,
    updates: rec?.n ?? 0,
    lastUpdatedAt: rec?.lastAt || null,
    history: {
      count: history.length,
      data: history
    }
  });
}





// ===================== PUBLIC: ADMIN & QUOTE ===============================






// Helper: read recent EGT history for a wholesaler (sorted newest→oldest, sliced to limit)


// ===================== UPDATE SCORE ON SETTLEMENT ==========================
// status: 'ON_TIME' | 'LATE' | 'DEFAULT'
// tenorDays, daysLate: integers

// Update EGT score when a finance request settles, and record history
// async updateWholesalerScoreOnSettlement(ctx, wholesalerId, status, tenorDays, daysLate) {
//   if (!wholesalerId) throw new Error('wholesalerId required');

//   // ===== 0) Normalize inputs =====
//   const st      = String(status || '').toUpperCase();     // 'ON_TIME' | 'LATE' | 'DEFAULT' | ...
//   const tDays   = Math.max(1, Number(tenorDays) || 1);
//   const dLate   = Math.max(0, Number(daysLate) || 0);
//   const onTime  = st === 'ON_TIME';
//   const def     = st === 'DEFAULT';
//   const late    = !onTime && !def && dLate > 0;

//   // ===== 1) Params & current score =====
//   const params  = await this._getEGTParams(ctx);          // { w_on, w_late, w_def, w_days, eta, baselineAlpha, ... }
//   const rec     = await this._getScore(ctx, wholesalerId);// { s, n, lastAt, ... } or {}
//   const s0      = Number(rec?.s ?? 0.5);                  // default prior
//   const n0      = Number(rec?.n ?? 0);

//   // ===== 2) Compute instantaneous payoff π and update baseline π̄ =====
//   const pi = (Number(params.w_on)   * (onTime ? 1 : 0))
//            - (Number(params.w_late) * (late   ? 1 : 0))
//            - (Number(params.w_def)  * (def    ? 1 : 0))
//            - (Number(params.w_days) * Math.min(1, dLate / tDays));

//   const piBar0 = await this._getBaseline(ctx);            // previous baseline
//   const alpha  = Number(params.baselineAlpha ?? 0.1);
//   const piBar1 = (1 - alpha) * Number(piBar0) + alpha * Number(pi);
//   await this._setBaseline(ctx, piBar1);

//   // ===== 3) EGT score update: logit step + sigmoid =====
//   const eta = Number(params.eta ?? 0.5);
//   const z1  = this._logit(s0) + eta * (pi - piBar1);
//   const s1  = this._sigmoid(z1);

//   // ===== 4) Timestamps (use SIM time, not wall clock) =====
//   const nowIso = await this._simNowISO(ctx);

//   // ===== 5) Persist "current" score (back-compat) =====
//   await this._setScore(ctx, wholesalerId, {
//     s: s1,
//     n: n0 + 1,
//     lastAt: nowIso,
//     // (optional) expose last settlement signal for debugging
//     lastSignal: { status: st, tenorDays: tDays, daysLate: dLate, pi, piBar: piBar1 }
//   });

//   // ===== 6) Append HISTORY record (append-only; easy to query as time series) =====
//   // Keyspace: ('egtScoreHist', [wholesalerId, ISO])
//   const histKey = ctx.stub.createCompositeKey('egtScoreHist', [String(wholesalerId), nowIso]);
//   const histRec = {
//     wholesalerId: String(wholesalerId),
//     at: nowIso,
//     status: st,
//     tenorDays: tDays,
//     daysLate: dLate,
//     pi,
//     piBar: piBar1,
//     sPrev: s0,
//     sNext: s1
//   };
//   await ctx.stub.putState(histKey, Buffer.from(JSON.stringify(histRec)));

//   // (Optional) emit event for listeners/dashboards
//   await ctx.stub.setEvent('EGTScoreUpdated', Buffer.from(JSON.stringify({
//     wholesalerId: String(wholesalerId),
//     sPrev: s0,
//     sNext: s1,
//     at: nowIso,
//     status: st
//   })));

//   // ===== 7) Return a rich payload =====
//   return JSON.stringify({
//     ok: true,
//     wholesalerId: String(wholesalerId),
//     status: st,
//     tenorDays: tDays,
//     daysLate: dLate,
//     pi,
//     piBar: piBar1,
//     scorePrev: s0,
//     scoreNext: s1,
//     at: nowIso
//   });
// }



// In your contract class


async quoteFinanceForWholesaler(ctx, wholesalerId,financierId ,principalAmount,reqId) {
  if (!wholesalerId) throw new Error('wholesalerId required');

  // 1) Load finance policy (per-financier if provided, else global fallback).
  // APR quotes intentionally use policy values, not EGT score adjustment.
  let policy;
  if (financierId && typeof this._getFinancePolicyFor === 'function') {
    policy = await this._getFinancePolicyFor(ctx, String(financierId), 'false');
  } else {
    policy = await this._getFinancePolicy(ctx);  // your global policy
  }

  // 2) Neutral score means base policy terms: baseAPR/base tenor/base LTV.
  const score = 0.5;
  

  // 4) Score → tenor and fee%
  const t = this._termsFromScore(policy, score);
  
  // FEE: immutable 1%
  const feePct = Number(t.feePct ?? 1.0); 
  const penaltyPct = Number(t.penaltyPct); 
  let aprPct = Number(t.aprPct);
  let tenorDays = Number(t.tenorDays);
  let offer = null;
  if (financierId) {
    offer = await this._getFinanceOffer(ctx, wholesalerId, financierId);
    if (!offer && typeof this._buildAutoRLOffer === 'function') {
      offer = await this._buildAutoRLOffer(ctx, wholesalerId, financierId, principalAmount, '');
    }
    if (offer) {
      const offerApr = Number(offer.aprPct);
      const offerTenor = Number(offer.tenorDays);
      if (Number.isFinite(offerApr) && offerApr > 0) aprPct = offerApr;
      if (Number.isFinite(offerTenor) && offerTenor > 0) tenorDays = offerTenor;
    }
  }
  
  const ltvCapPct = Number(t.ltvPct);

  // 5) Principal sanity
  const principal = Number(principalAmount || 0);
  if (!Number.isFinite(principal) || principal <= 0) throw new Error('Invalid principal');

  // 6) Pricing (fee % and APR decimal)
  const createdIso  = await this._nowISO(ctx);
  const feeAmt      = this._round(principal * (feePct / 100), policy.roundMoney);
  const interestAmt = this._round(principal * (aprPct/100) * (tenorDays / 365), policy.roundMoney);
  const totalPayable = this._round(principal + feeAmt + interestAmt, policy.roundMoney);

  return JSON.stringify({
    wholesalerId,
    financierId: financierId || null,
    score,
    terms: { aprPct, feePct,penaltyPct, tenorDays, ltvCapPct, source: offer ? 'RL' : 'POLICY' },
    pricing: {
      principalAmount: principal,
      feeAmt,
      interestAmt,
      totalPayable,
      snapshotTs: createdIso
    }
  });
}

async listFinancierOffersForWholesaler(ctx, principalAmount = '', tenorDaysRequested = '') {
  this._logInvocation("listFinancierOffersForWholesaler", arguments, ctx);
  this._requireOrg(ctx, 'WholesalersMSP');

  const wholesalerId = this._userId ? this._userId(ctx) : 'unknown';
  const principal = Number(principalAmount || 0);
  const requestedTenor = Number(tenorDaysRequested || 0);
  const includePricing = Number.isFinite(principal) && principal > 0;

  const iter = await ctx.stub.getStateByPartialCompositeKey('finOffer', [String(wholesalerId)]);
  const offers = [];
  const seen = new Set();
  for (let r = await iter.next(); !r.done; r = await iter.next()) {
    if (!r.value?.value) continue;
    const offer = JSON.parse(r.value.value.toString('utf8'));
    seen.add(String(offer.financierId));
    const tenorDays = Number.isFinite(requestedTenor) && requestedTenor > 0
      ? Math.min(requestedTenor, Number(offer.tenorDays || requestedTenor))
      : Number(offer.tenorDays || 0);

    const row = {
      financierId: offer.financierId,
      wholesalerId,
      source: offer.source || 'RL',
      aprPct: Number(offer.aprPct),
      baseAprPct: Number(offer.baseAprPct),
      feePct: Number(offer.feePct ?? 1.0),
      penaltyPct: Number(offer.penaltyPct ?? 0),
      tenorDays,
      ltvCapPct: Number(offer.ltvCapPct ?? 0),
      updatedAt: offer.updatedAt,
      rl: offer.rl || null
    };

    if (includePricing && Number.isFinite(row.aprPct) && Number.isFinite(tenorDays) && tenorDays > 0) {
      const feeAmt = this._round(principal * (row.feePct / 100), 2);
      const interestAmt = this._round(principal * (row.aprPct / 100) * (tenorDays / 365), 2);
      row.pricing = {
        principalAmount: principal,
        feeAmt,
        interestAmt,
        totalPayable: this._round(principal + feeAmt + interestAmt, 2)
      };
    }
    offers.push(row);
  }
  await iter.close();

  const financierIds = await this._listKnownFinancierIds(ctx);
  for (const financierId of financierIds) {
    if (seen.has(String(financierId))) continue;
    const offer = await this._buildAutoRLOffer(ctx, wholesalerId, financierId, principalAmount, tenorDaysRequested);
    offers.push({
      financierId: offer.financierId,
      wholesalerId,
      source: offer.source,
      aprPct: Number(offer.aprPct),
      baseAprPct: Number(offer.baseAprPct),
      feePct: Number(offer.feePct ?? 1.0),
      penaltyPct: Number(offer.penaltyPct ?? 0),
      tenorDays: Number(offer.tenorDays),
      ltvCapPct: Number(offer.ltvCapPct ?? 0),
      updatedAt: offer.updatedAt,
      rl: offer.rl || null,
      pricing: offer.pricing || undefined
    });
  }

  offers.sort((a, b) => Number(a.aprPct) - Number(b.aprPct));
  return JSON.stringify(offers);
}



// createFinanceRequestForLot_Auto(lotId, financierId, requesterId, principalAmount)
// EGT-based finance request for a lot (principal = auction winner total)
// Caller: wholesalers; Requester must be the winning bidder.
// Tenor is provided by caller but capped by EGT quote (and optionally financier terms).
async createFinanceRequestForLot_EGT(ctx, lotId, financierId, tenorDaysRequested) {
  this._logInvocation("createFinanceRequestForLot_EGT", arguments, ctx);
  this._requireOrg(ctx, 'WholesalersMSP');

  if (!lotId)       throw new Error('lotId required');
  if (!financierId) throw new Error('financierId required');

  const requesterId = this._userId ? this._userId(ctx) : 'unknown';

  // --- Load lot & auction ---
  const lotKey = ctx.stub.createCompositeKey('lot', [String(lotId)]);
  const lotBytes = await ctx.stub.getState(lotKey);
  if (!lotBytes?.length) throw new Error(`Lot ${lotId} not found`);
  const lot = JSON.parse(lotBytes.toString());

  const aKey = ctx.stub.createCompositeKey('auction', [String(lotId)]);
  const aBytes = await ctx.stub.getState(aKey);
  if (!aBytes?.length) throw new Error(`Auction not found for lot ${lotId}`);
  const auction = JSON.parse(aBytes.toString());

  if (lot.status !== 'BID-ACCEPTED') {
    throw new Error(`Lot ${lotId} not approved by farmer (status=${lot.status})`);
  }
  if (auction.status !== 'CLOSED') {
    throw new Error(`Auction for lot ${lotId} must be CLOSED (current=${auction.status})`);
  }
  if (!auction.highestBid) throw new Error('No highest bid recorded');

  const { bidderId, totalAmount } = auction.highestBid;
  if (String(bidderId) !== String(requesterId)) {
    throw new Error(`Only the winning bidder (${bidderId}) can request finance for this lot`);
  }

  const principal = Number(totalAmount);
  if (!Number.isFinite(principal) || principal <= 0) {
    throw new Error(`Invalid principal from auction: ${totalAmount}`);
  }

  // --- EGT quote (assumed percent rates) ---
  const reqId = ctx.stub.getTxID();
  const qRaw = await this.quoteFinanceForWholesaler(ctx, requesterId,financierId,principal,reqId);
  
  const q = typeof qRaw === 'string' ? JSON.parse(qRaw) : qRaw;

  const egtFeePct    = Number(q?.terms?.feePct ?? 0);                 // %
  const egtAprPct    = Number(q?.terms?.aprPct ?? 0);                // %
  const egtPenaltyPct= Number(q?.terms?.penaltyPct ?? 0);             // % per overdue day (policy)
  const egtTenorMax  = Number(q?.terms?.tenorDays ?? 0);
  const rateSource   = q?.terms?.source || 'POLICY';
  const snapshotTs   = q?.pricing?.snapshotTs || (this._simNowISO ? await this._simNowISO(ctx) : new Date().toISOString());

  if (!Number.isFinite(egtTenorMax) || egtTenorMax <= 0) {
    throw new Error('EGT quote missing valid tenorDays');
  }

  

  // Final tenor (caller request capped by EGT & financier)
  let tenorDays = egtTenorMax;
  if (tenorDaysRequested !== undefined && tenorDaysRequested !== null && tenorDaysRequested !== '') {
    const t = Number(tenorDaysRequested);
    if (!Number.isFinite(t) || t <= 0) throw new Error('tenorDaysRequested must be a positive number');
    tenorDays = Math.min(t, egtTenorMax);
  }

  // --- Pricing (percent → divide by 100) ---
  const feeAmt       = principal * (egtFeePct / 100);
  const interestAmt  = principal * (egtAprPct / 100) * (tenorDays / 365);
  const totalPayable = principal + feeAmt + interestAmt;

  // --- Timestamps ---
  const createdIso = snapshotTs;
  const dueIso = new Date(Date.parse(createdIso) + tenorDays * 86400000).toISOString();

  // --- Idempotency per (lotId, bidderId) ---
  const reqKey = ctx.stub.createCompositeKey('financeReq', [String(lotId), String(requesterId)]);
  const prev = await ctx.stub.getState(reqKey);
  if (prev?.length) {
    const p = JSON.parse(prev.toString());
    if (p.status !== 'REJECTED') {
      throw new Error(`A finance request already exists for lot ${lotId} by ${requesterId} (status=${p.status})`);
    }
  }

  // --- Build and store request ---
  const request = {
    docType: 'financeRequest',
    requestId: reqId,
    lotId,
    financierId,
    requesterId,
    requesterOrg: 'WholesalersMSP',
    principalAmount: Number(principal.toFixed(2)),
    outstanding:Number(totalPayable.toFixed(2)),
    repaidAmt:0,
    wholesalePaid:0,
    penaltyAccum: 0,
    overdue: 0,               // cumulative penalties+extra interest accrued so far
    payments: [],
    pricing: {
      feePct: egtFeePct,
      annualInterestPct: egtAprPct,      // keep as percent (no *100)
      penaltyPct: egtPenaltyPct,         // % per overdue day (used later for penalties)
      tenorDays,
      snapshotTs: createdIso
    },
    computed: {
      feeAmt: Number(feeAmt.toFixed(2)),
      interestAmt: Number(interestAmt.toFixed(2)),
      totalPayable: Number(totalPayable.toFixed(2))
    },
    status: 'PENDING',
    createdAt: createdIso,
    dueAt: dueIso,
    termsSnapshot: {
      source: rateSource,
      score: q?.score ?? null,
      egtTenorMax
      
    }
  };

  await ctx.stub.putState(reqKey, Buffer.from(JSON.stringify(request)));
  await ctx.stub.setEvent('FinanceRequested', Buffer.from(JSON.stringify({
    lotId,
    requestId: request.requestId,
    requesterId,
    financierId,
    principal: request.principalAmount,
    tenorDays,
    feePct: egtFeePct,
    aprPct: egtAprPct,
    penaltyPct: egtPenaltyPct,
    source: rateSource
  })));

  return `✅ Finance (${rateSource}) ${request.requestId} for lot ${lotId} → principal ₹${request.principalAmount}, tenor ${tenorDays}d, fee ${egtFeePct}%, APR ${egtAprPct}%`;
}





// ===== MATH HELPERS ========================================================
_round(n, d=2){ const k = 10**d; return Math.round((Number(n)||0)*k)/k; }
_clamp(v, lo, hi){ return Math.min(hi, Math.max(lo, v)); }

// Map score->fee/apr/tenor/ltv. APR policy values may be stored as decimals
// (0.18 = 18%) or whole percentages (18 = 18%); return aprPct as a percent.



_termsFromScore(policy, s) {
  const sc = Math.max(0, Math.min(1, Number(s))); // clamp score [0,1]

  // --- Fee fixed ---
  const feePct = Number(policy.feePct ?? 1.0);

  // helper clamp
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const rate = (v, fb = 0) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fb;
    return Math.abs(n) > 1 ? n / 100 : n;
  };

  // ========== CENTERED FORMULA ==========
  // f(s) = base + (max - min) * (0.5 - s)

  // ---- APR (interest rate): decreases with higher score ----
  const minAPR = rate(policy.minAPR, 0.06);
  const maxAPR = rate(policy.maxAPR, 0.48);
  const baseAPR = rate(policy.baseAPR, 0.18);
  let interestRate = baseAPR + (maxAPR - minAPR) * (0.5 - sc);
  interestRate = clamp(interestRate, minAPR, maxAPR);
  const aprPct = Number((interestRate * 100).toFixed(2));

  // ---- Penalty: decreases with higher score ----
  let penaltyPct = Number(policy.penaltyBasePct)
    + (Number(policy.penaltyMaxPct) - Number(policy.penaltyMinPct)) * (0.5 - sc);
  penaltyPct = clamp(penaltyPct, Number(policy.penaltyMinPct), Number(policy.penaltyMaxPct));

  // ---- Tenor: increases with higher score ----
  let tenorDays = Number(policy.tenor)
    + (Number(policy.maxTenorDays) - Number(policy.minTenorDays)) * (sc - 0.5);
  tenorDays = clamp(Math.round(tenorDays), Number(policy.minTenorDays), Number(policy.maxTenorDays));

  // ---- LTV: increases with higher score ----
  const baseLtvPct = Number.isFinite(Number(policy.ltv))
    ? Number(policy.ltv)
    : (Number(policy.maxLtvPct) + Number(policy.minLtvPct)) / 2;
  let ltvPct = baseLtvPct + (Number(policy.maxLtvPct) - Number(policy.minLtvPct)) * (sc - 0.5);
  ltvPct = clamp(ltvPct, Number(policy.minLtvPct), Number(policy.maxLtvPct));

  return { feePct, penaltyPct, aprPct, tenorDays, ltvPct };
}


// ===================== UPDATE FINANCIER PAYMENT → s =====================
// π = clip((InterestReceived + FeeReceived - LostMoney) / TotalDisbursed, -1, 1)
// LostMoney = sum(max(0, principal - principalRepaid - recovery)) only for DEFAULTs

// --- params (no weights, just eta & baseline smoothing) ---
async _getFinEGTParams(ctx) {
  const b = await ctx.stub.getState('fin:egt:params');
  if (b?.length) return JSON.parse(b.toString());
  return { eta: 0.5, baselineAlpha: 0.25 }; // defaults
}

// --- score + baseline storage for financiers ---
_finScoreKey(finId) { return `fin:egt:score:${String(finId)}`; }
async _getFinScore(ctx, finId) {
  const b = await ctx.stub.getState(this._finScoreKey(finId));
  return b?.length ? JSON.parse(b.toString()) : { s: 0.5, n: 0, lastAt: '' };
}
async _setFinScore(ctx, finId, rec) {
  await ctx.stub.putState(this._finScoreKey(finId), Buffer.from(JSON.stringify(rec)));
}
async _getFinBaseline(ctx) {
  const b = await ctx.stub.getState('fin:egt:baseline');
  return b?.length ? Number(b.toString()) : 0;
}
async _setFinBaseline(ctx, v) {
  await ctx.stub.putState('fin:egt:baseline', Buffer.from(String(v)));
}

// --- helpers ---
async _drainKV(iterator) {
  const out = [];
  for (let r = await iterator.next(); !r.done; r = await iterator.next()) {
    if (r.value?.value) out.push(JSON.parse(r.value.value.toString('utf8')));
  }
  await iterator.close();
  return out;
}
_inWindow(iso, sinceIso, untilIso) {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  if (sinceIso && t < Date.parse(sinceIso)) return false;
  if (untilIso && t > Date.parse(untilIso)) return false;
  return true;
}





async updateScoresAllFinanceRequests(ctx) {
  const U = s => String(s || '').toUpperCase();
  const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const nowIso = this._simNowISO ? await this._simNowISO(ctx) : new Date().toISOString();

  try { await this.confirmAllPacketsSoldAndMark(ctx); } catch {}

  // --- Load all finance requests ---
  const iterator = await ctx.stub.getStateByPartialCompositeKey('financeReq', []);
  const finCache = new Map();
  const whCache  = new Map();
  let scanned = 0, eligible = 0, updated = 0, scoredFin = 0, scoredWh = 0, check = 0, check1 = 0, check2 = 0,check3=0 ;

  while (true) {
    const r = await iterator.next();
    if (!r.value || !r.value.value) {
      if (r.done) break;
      else continue;
    }

    let fr;
    try { fr = JSON.parse(r.value.value.toString('utf8')); }
    catch { if (r.done) break; else continue; }

    scanned++;

    const reqId = String(fr?.requestId || fr?.id || '').trim();
    if (!reqId) continue;

    const soldFlag = U(fr?.status_sold || fr?.soldstatus) === 'ALL_SOLD';
    const egtDone  = U(fr?.status_egt || fr?.egtstatus) === 'EGT_SETTLED';
    if (!soldFlag || egtDone) continue;   // only ALL_SOLD + not yet settled
    eligible++;
    
    check++;
    const financierId  = String(fr?.financierId || '').trim();
    const wholesalerId = String(fr?.requesterId || '').trim();
    if (!financierId || !wholesalerId) continue;
    check1++;
    
    // ---------- FINANCIER ----------
    let finState = finCache.get(financierId);
    if (!finState) {
      const p = await this._getFinEGTParams(ctx);
      const sRec = await this._getFinScore(ctx, financierId);
      finState = {
        alpha: Number(p?.baselineAlpha ?? 0.3),
        eta:   Number(p?.eta ?? 0.5),
        s:     Number.isFinite(Number(sRec?.s)) ? Number(sRec.s) : 0.5,
        n:     Number.isFinite(Number(sRec?.n)) ? Number(sRec.n) : 0,
        piBar: Number(await this._getFinBaseline(ctx))
      };
      finCache.set(financierId, finState);
    }
    check2++;
    const createdMs = Date.parse(fr?.createdAt ?? '');
    const settledMs = Date.parse(fr?.settledAt ??  '');
    const allSoldAtMs = Date.parse(fr?.allSoldAt ??  '');
    const days_settle = (Number.isFinite(createdMs) &&
                         Number.isFinite(settledMs) &&
                         settledMs > createdMs)
                        ? (settledMs - createdMs) / 86400000
                        : 0;
    const days_taken_to_sell = (Number.isFinite(createdMs) &&
                         Number.isFinite(allSoldAtMs) &&
                         allSoldAtMs > createdMs)
                        ? (allSoldAtMs - createdMs) / 86400000
                        : 0;                   
    fr.days_settle = Number(days_settle.toFixed(2));
    fr.days_taken_to_sell = Number(days_taken_to_sell.toFixed(2));
    check3++;
    const tenorDays = n(fr?.pricing?.tenorDays ?? fr?.tenorDays ?? 0);
    const days = fr?.overdue === 0 ? fr.days_settle : fr.overdue + tenorDays;
    fr.days = days;
    const ratio = clamp(tenorDays / days, 0.25, 4.0);
    const pifin_raw = n(fr?.financierprofitpercent ?? fr?.financierprofit ?? 0) * (ratio);
    fr.pifin_raw = pifin_raw;

    if (Number.isFinite(pifin_raw)) {
      const pi = clamp(pifin_raw, -1, 1);
      const { alpha, eta } = finState;
      finState.piBar = (1 - alpha) * finState.piBar + alpha * pi;
      const z1 = this._logit(finState.s) + eta * (pi - finState.piBar);
      finState.s = this._sigmoid(z1);
      finState.n += 1;
      fr.finScore = finState.s;
      await this._setFinBaseline(ctx, finState.piBar);
      await this._setFinScore(ctx, financierId, {
        s: finState.s, n: finState.n, lastAt: nowIso,
        lastSignal: { mode: 'auto', frId: reqId, pifin: pi }
      });
      await this._appendFinEGTHistory(ctx, financierId, {
        ts: nowIso,
        pi: pifin_raw,
        s: finState.s,
        piBar: finState.piBar,
        frId: fr.requestId,
        apr: fr.pricing?.annualInterestPct,
        penaltyPct: fr.pricing?.penaltyPct,
        tenorDays: fr.pricing?.tenorDays,
        financierprofit: fr.financierprofitpercent,
        wholesalerprofit: fr.wholesalerprofitpercent,
        overdue: fr.overdue,
        days_settle: fr.days_settle,
        days_taken_to_sell: fr.days_taken_to_sell,
        grosssale: fr.grosssale,
        principal: fr.principalAmount,
        interest: fr.computed?.interestAmt,
        wholesalerPaid: fr.wholesalePaid,
        repaid: fr.repaidAmt
      });
      scoredFin++;
    }

    // ---------- WHOLESALER ----------
    let whState = whCache.get(wholesalerId);
    if (!whState) {
      const p = await this._getEGTParams(ctx);
      const sRec = await this._getScore(ctx, wholesalerId);
      whState = {
        alpha: Number(p?.baselineAlpha ?? 0.1),
        eta:   Number(p?.eta ?? 0.5),
        s:     Number.isFinite(Number(sRec?.s)) ? Number(sRec.s) : 0.5,
        n:     Number.isFinite(Number(sRec?.n)) ? Number(sRec.n) : 0,
        piBar: Number(await this._getBaseline(ctx))
      };
      whCache.set(wholesalerId, whState);
    }

    const piwh_raw = n(fr?.wholesalerprofitpercent ?? fr?.wholesalerprofit ?? 0);
    if (Number.isFinite(piwh_raw)) {
      const pi = clamp(piwh_raw, -1, 1);
      const { alpha, eta } = whState;
      whState.piBar = (1 - alpha) * whState.piBar + alpha * pi;
      const z = this._logit(whState.s) + eta * (pi - whState.piBar);
      whState.s = this._sigmoid(z);
      whState.n += 1;
      fr.whScore = whState.s;
      await this._setBaseline(ctx, whState.piBar);
      await this._setScore(ctx, wholesalerId, {
        s: whState.s, n: whState.n, lastAt: nowIso
      });
      

      
        await this._appendWhEGTHistory(ctx, wholesalerId, {
          ts: nowIso,
          pi: piwh_raw,
          s: whState.s,
          piBar: whState.piBar,
          frId: fr.requestId,
          apr: fr.pricing?.annualInterestPct,
          penaltyPct: fr.pricing?.penaltyPct,
          tenorDays: fr.pricing?.tenorDays,
          financierprofit: fr.financierprofitpercent,
          wholesalerprofit: fr.wholesalerprofitpercent,
          overdue: fr.overdue,
          days_settle: fr.days_settle,
          days_taken_to_sell: fr.days_taken_to_sell,
          grosssale: fr.grosssale,
          principal: fr.principalAmount,
          interest: fr.computed?.interestAmt,
          wholesalerPaid: fr.wholesalePaid,
          repaid: fr.repaidAmt
        });
        
        
      
      scoredWh++;
    }

    // --- finalize this FR ---
    fr.status_egt   = 'EGT_SETTLED';
    fr.egtSettledAt = nowIso;
    await ctx.stub.putState(r.value.key, Buffer.from(JSON.stringify(fr)));
    updated++;
  }

  await iterator.close();

  return JSON.stringify({
    ok: true,
    at: nowIso,
    scanned,
    eligible,
    updated,
    check,
    check1,
    check2,
    check3,
    scoredFin,
    scoredWh
  });
}


/**
 * Confirm all packets linked to a finance request are sold.
 * Link rule:
 *   - Prefer packets with packet.finReqId === financeRequestId
 *   - Fallback to lot linkage: packet.lotId === financeRequest.lotId
 *
 * "Sold" statuses recognized (tweak as needed):
 *   SOLD, PURCHASED, DELIVERED, COMPLETED
 *
 * @returns {
 *   ok: true,
 *   financeRequestId, lotId,
 *   allSold: boolean,
 *   totals: { total, sold, available, reserved, rejected, other },
 *   unsoldIds: string[]
 * }
 */
/**
 * Scan every finance request and mark status1='ALL_SOLD' when all linked packets are sold.
 * Link rule:
 *   1) Prefer packets where packet.finReqId === fr.requestId
 *   2) Else (if no finReqId on packet) fall back to packet.lotId === fr.lotId
 *
 * "Sold" statuses recognized (edit to match your enums):
 *   SOLD, PURCHASED, DELIVERED, COMPLETED
 *
 * Returns a summary of updates.
 */
/**
 * Scan all finance requests and, for each FR, check if **all packets of its lotId** are sold.
 * If yes, set fr.status1 = 'ALL_SOLD' and fr.allSoldAt = now.
 *
 * Sold status set is minimal (PER YOUR CURRENT ENUM): { 'PURCHASED' }.
 * Expand SOLD_SET if you also use other sold-like statuses (e.g., SOLD, DELIVERED, COMPLETED).
 */
async confirmAllPacketsSoldAndMark(ctx) {
  const U = s => String(s || '').toUpperCase();
  const nowIso = this._simNowISO ? await this._simNowISO(ctx) : new Date().toISOString();

  // === tune these to your enums ===
  const SOLD_SET     = new Set(['PURCHASED', 'SOLD']);   // include both if your flows vary
  const AVAIL_SET    = new Set(['AVAILABLE','AVAILABLE_FOR_PURCHASE']);
  const RESERVED_SET = new Set(['RESERVED','HELD']);
  const REJECTED_SET = new Set(['REJECTED','CANCELLED','CANCELED']);

  // ---------- 1) Preload ALL packets once and bucket by lotId ----------
  const lotPackets = new Map();  // lotId -> [packet, ...]
  const lotStats   = new Map();  // lotId -> { total, sold, available, reserved, rejected, other, allSold }

  // light diagnostics (returned to caller)
  let kvSeen = 0, parsed = 0, missingLotId = 0;
  const sampleStatuses = new Set();

  const itP = await ctx.stub.getStateByPartialCompositeKey('packet', []);
  try {
    while (true) {
      const r = await itP.next();
      if (r.value) kvSeen++;
      if (r.value && r.value.value) {
        let p;
        try { p = JSON.parse(r.value.value.toString('utf8')); parsed++; } catch { /* skip malformed */ }
        if (!p) { if (r.done) break; continue; }

        // 1) prefer JSON field
        let lotId = String(p?.lotId || '').trim();

        // 2) fallback: derive from composite key attribute "LOT-...-PKT-<n>"
        if (!lotId) {
          try {
            const { attributes } = ctx.stub.splitCompositeKey(r.value.key) || {};
            const token = attributes?.[0] || '';  // your schema packs id here
            lotId = token.replace(/-PKT-\d+$/i, '').trim();
          } catch { /* keep empty */ }
        }

        if (!lotId) { missingLotId++; if (r.done) break; continue; }

        if (p?.status) sampleStatuses.add(String(p.status));

        let arr = lotPackets.get(lotId);
        if (!arr) { arr = []; lotPackets.set(lotId, arr); }
        arr.push(p);
      }
      if (r.done) break;
    }
  } finally {
    if (itP && itP.close) await itP.close();
  }

  // Precompute per-lot tallies
  for (const [lotId, pkts] of lotPackets.entries()) {
    let sold=0, available=0, reserved=0, rejected=0, other=0;
    for (const p of pkts) {
      const st = U(p?.status);
      if (SOLD_SET.has(st)) sold++;
      else if (AVAIL_SET.has(st))    available++;
      else if (RESERVED_SET.has(st)) reserved++;
      else if (REJECTED_SET.has(st)) rejected++;
      else other++;
    }
    lotStats.set(lotId, {
      total: pkts.length,
      sold, available, reserved, rejected, other,
      allSold: pkts.length > 0 && sold === pkts.length
    });
  }

  // ---------- 2) Walk all finance requests, link by lotId only ----------
  let scanned = 0, updated = 0;
  const updatedIds = [];
  const itFR = await ctx.stub.getStateByPartialCompositeKey('financeReq', []);
  try {
    while (true) {
      const r = await itFR.next();
      if (!r.value || !r.value.value) {
        if (r.done) break;
        continue;
      }
      scanned++;

      const frKey = r.value.key;
      const fr    = JSON.parse(r.value.value.toString('utf8'));

      const reqId = String(fr?.requestId || fr?.id || '').trim();
      const lotId = String(fr?.lotId || '').trim();
      if (!lotId) continue;                          // no lot link → cannot decide

      const stats = lotStats.get(lotId);
      if (!stats) continue;                          // no packets exist for this lot

      // decide & update
      const alreadyAllSold = U(fr?.status_sold || '') === 'ALL_SOLD';
      if (stats.allSold && !alreadyAllSold) {
        fr.status_sold   = 'ALL_SOLD';
        fr.allSoldAt = nowIso;

        await ctx.stub.putState(frKey, Buffer.from(JSON.stringify(fr)));
        updated++;
        updatedIds.push(reqId || frKey);

        // Optional event
        await ctx.stub.setEvent('FinanceRequestAllSold', Buffer.from(JSON.stringify({
          requestId: reqId || null,
          lotId,
          totalPackets: stats.total,
          soldPackets:  stats.sold,
          at: nowIso
        })));
      }

      if (r.done) break;
    }
  } finally {
    if (itFR && itFR.close) await itFR.close();
  }

  return {
    ok: true,
    at: nowIso,
    scanned,
    updated,
    updatedIds,
    // diagnostics
    diag: {
      kvSeen,
      parsed,
      missingLotId,
      lotsWithPackets: lotPackets.size,
      sampleStatuses: Array.from(sampleStatuses).slice(0, 10)
    }
  };
}



// Update financier score from portfolio signals (pifin, piwh).
// If wholesalerId is provided, also update wholesaler score from piwh.
// Signature expanded but remains backward compatible.



// === Read financier EGT history (newest → oldest), sliced to `limit`
async _readFinEGTHistory(ctx, financierId, limit = 25) {
  const id = String(financierId).trim();
  const lim = Math.min(Math.max(Number(limit) || 0, 1), 200); // clamp 1..200

  const iter = await ctx.stub.getStateByPartialCompositeKey('egtFinHist', [id]);
  const rows = [];

  while (true) {
    const r = await iter.next();
    if (r.value && r.value.value) {
      try {
        const rec = JSON.parse(r.value.value.toString('utf8')); // { at, sPrev, sNext, ... }
        rows.push(rec);
      } catch {
        /* skip malformed */
      }
    }
    if (r.done) break;
  }

  await iter.close();

  // sort newest → oldest and slice to limit
  rows.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return rows.slice(0, lim);
}

async readFinEGTHistory(ctx,financierId, limit = 25){
  const summary= await this._readFinEGTHistory(ctx, financierId, limit = 25) ;
  return JSON.stringify(summary);
}

async _appendFinEGTHistory(ctx, financierId, rec) {
  // --- Normalize inputs ---
  const id = String(financierId || '').trim();
  if (!id) throw new Error('financierId required');
  if (!rec || typeof rec !== 'object') throw new Error('record object required');

  // --- Ensure timestamp field ---
  const nowIso = rec.at || (this._simNowISO ? await this._simNowISO(ctx) : new Date().toISOString());
  rec.at = nowIso;

  // --- Build composite key ---
  // Key structure:  egtFinHist::<financierId>::YYYY-MM-DDTHH:mm:ssZ
  const key = ctx.stub.createCompositeKey('egtFinHist', [id, nowIso]);

  // --- Write record ---
  await ctx.stub.putState(key, Buffer.from(JSON.stringify(rec)));

  // --- Optional debug log ---
  console.log(`📘 appended financier history for ${id} @ ${nowIso}`);
}


async _readEGTHistory(ctx, wholesalerId, sinceIso = '', limit = 25) {
  const id = String(wholesalerId).trim();
  const lim = Math.min(Math.max(Number(limit) || 0, 1), 200); // 1..200
  const iter = await ctx.stub.getStateByPartialCompositeKey('egtScoreHist', [id]);
  const rows = [];
  while (true) {
    const r = await iter.next();
    if (r.value && r.value.value) {
      try {
        const rec = JSON.parse(r.value.value.toString('utf8')); // { at, sPrev, sNext, ... }
        if (sinceIso && String(rec.at || '') < String(sinceIso)) { /* skip older */ }
        else rows.push(rec);
      } catch { /* skip malformed */ }
    }
    if (r.done) break;
  }
  await iter.close();
  // newest-first
  rows.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return rows.slice(0, lim);
}


async _appendWhEGTHistory(ctx, wholesalerId, rec) {
  // --- Normalize inputs ---
  const id = String(wholesalerId || '').trim();
  if (!id) throw new Error('wholesalerId required');
  if (!rec || typeof rec !== 'object') throw new Error('record object required');

  // --- Ensure timestamp field ---
  const nowIso = rec.at || (this._simNowISO ? await this._simNowISO(ctx) : new Date().toISOString());
  rec.at = nowIso;

  // --- Build composite key ---
  // Key format: egtScoreHist::<wholesalerId>::YYYY-MM-DDTHH:mm:ssZ
  const key = ctx.stub.createCompositeKey('egtScoreHist', [id, nowIso]);

  // --- Write record ---
  await ctx.stub.putState(key, Buffer.from(JSON.stringify(rec)));

  // --- Optional debug log ---
  console.log(`📗 appended wholesaler history for ${id} @ ${nowIso}`);
}


// === Public read: financier score (+ optional history)
// Replace your existing getFinancierScore with this version
async getFinancierScore(ctx, financierId, includeHistory = 'true', historyLimit = '25') {
  this._logInvocation("getFinancierScore", arguments, ctx);
  if (!financierId) throw new Error('financierId is required');
  const id = String(financierId).trim();

  // --- Optional refresh of all portfolio scores ---
  try { await this.updateScoresAllFinanceRequests(ctx); } catch {}

  // --- Read financier score ---
  let rec;
  if (typeof this._getFinScore === 'function') {
    rec = await this._getFinScore(ctx, id);
  } else {
    const b = await ctx.stub.getState(`egt:finScore:${id}`);
    rec = b?.length ? JSON.parse(b.toString()) : { s: 0.5, n: 0, lastAt: '' };
  }

  const sF = Number.isFinite(Number(rec?.s)) ? Math.max(0, Math.min(1, Number(rec.s))) : 0.5;

  // --- Read limited history ---
  let history = [];
  if (String(includeHistory).toLowerCase() === 'true') {
    const lim = Math.min(Math.max(Number(historyLimit) || 0, 1), 200);
    history = await this._readFinEGTHistory(ctx, id, lim);
  }

  // --- Always use your unified finance policy logic ---
  let effPolicy;
  try {
    effPolicy = await this._getFinancePolicyFor(ctx, id, 'true');
  } catch (err) {
    console.error('⚠️ _getFinancePolicyFor failed:', err);
    effPolicy = null;
  }

  // --- Fallback if something unexpected fails ---
  if (!effPolicy) {
    effPolicy = typeof this._defaultFinancePolicy === 'function'
      ? this._defaultFinancePolicy()
      : {
          roundMoney: 2, minTenorDays: 30, maxTenorDays: 600,
          tenor: 365,
          tenorAtS0: 45, tenorAtS1: 400,
          minLtvPct: 0, maxLtvPct: 100,
          ltvAtS0: 60, ltvAtS1: 100,
          baseAPR: 0.18, minAPR: 0.06, maxAPR: 0.48,
          spreadMax: 0.18, feePct: 1.0
        };
  }

  // --- Prepare a simplified view for API / dashboard ---
  const policyOut = {
    baseAPR: Number(effPolicy.baseAPR),
    baseAPRpct: Number((Number(effPolicy.baseAPR) ).toFixed(2)),
    spreadMax: Number(effPolicy.spreadMax ?? 0),
    spreadMaxPct: Number(((effPolicy.spreadMax ?? 0) ).toFixed(2)),
    minAPR: Number(effPolicy.minAPR),
    maxAPR: Number(effPolicy.maxAPR),
    tenor: Math.round(Number(effPolicy.tenor)),
    minTenorDays: Math.round(Number(effPolicy.minTenorDays)),
    maxTenorDays: Math.round(Number(effPolicy.maxTenorDays)),
    ltv: Number(effPolicy.ltv),
    minLtvPct: Number(effPolicy.minLtvPct),
    maxLtvPct: Number(effPolicy.maxLtvPct),
    penaltyBasePct: Number(effPolicy.penaltyBasePct ?? effPolicy.penalty ?? 0),
    feePct: 1.0,
    roundMoney: Number(effPolicy.roundMoney ?? 2)
  };

  // --- Attach effective policy snapshot to each history entry ---
  if (Array.isArray(history)) {
    for (const h of history) {
      try {
        const sHist = Number(h.s ?? h.sNext ?? sF ?? 0.5);
        h.policy = await this._getFinancePolicyFor(ctx, id, false); // no re-adjust
        h.policy.tenor = sHist * h.policy.maxTenorDays + (1 - sHist) * h.policy.minTenorDays;
      } catch {
        h.policy = effPolicy;
      }
    }
  }

  // --- Final response ---
  return JSON.stringify({
    financierId: id,
    score: sF,
    s: sF,
    updates: rec?.n ?? 0,
    lastUpdatedAt: rec?.lastAt || null,
    effectivePolicy: policyOut,
    history: history.length ? { count: history.length, data: history } : undefined
  });
}

  



// In your Contract class
async openAuction(ctx, lotId, reservePricePerKg, minIncrementPerKg) {
  this._requireOrg(ctx, 'AuctioncentersMSP');

  // --- Load lot ---
  const lotKey = ctx.stub.createCompositeKey('lot', [lotId]);
  const lotBytes = await ctx.stub.getState(lotKey);
  if (!lotBytes?.length) throw new Error('Lot not found');
  const lot = JSON.parse(lotBytes.toString());

  // --- Only APPROVED lots may be (re)opened ---
  if (lot.status !== 'APPROVED') {
    throw new Error(`Lot ${lotId} not eligible for auction (status=${lot.status}); must be APPROVED`);
  }

  // --- Parse inputs (allow reserve = null; minIncrement > 0) ---
  const reserve =
    reservePricePerKg === '' || reservePricePerKg === null || reservePricePerKg === undefined
      ? null
      : Number(reservePricePerKg);
  if (reserve !== null && (!Number.isFinite(reserve) || reserve < 0)) {
    throw new Error('Invalid reservePricePerKg');
  }
  const inc = Number(minIncrementPerKg);
  if (!Number.isFinite(inc) || inc <= 0) {
    throw new Error('minIncrementPerKg must be > 0');
  }

  // --- Auction key ---
  const aKey = ctx.stub.createCompositeKey('auction', [lotId]);
  const existing = await ctx.stub.getState(aKey);

  // Helper: ledger time
  const nowIso = await this._simNowISO(ctx);


  if (existing?.length) {
    // --- Auction exists: (Re)open path ---
    const a = JSON.parse(existing.toString());

    // Block reopen if already paid/sold
    if (a.paid || lot.status === 'PAID') {
      throw new Error(`Cannot (re)open auction for ${lotId}: payment already recorded / lot is PAID`);
    }

    if (a.status === 'OPEN') {
      // Idempotent: already OPEN; just allow updating params
      a.reservePricePerKg = reserve;
      a.minIncrementPerKg = inc;
      await ctx.stub.putState(aKey, Buffer.from(JSON.stringify(a)));
      await ctx.stub.setEvent('AuctionOpenIdempotent', Buffer.from(JSON.stringify({ lotId, status: a.status })));
      return `ℹ️ Auction already OPEN for ${lotId}; params updated`;
    }

    // CLOSED (or any non-OPEN) ⇒ Reopen
    a.status = 'OPEN';
    a.timePolicy = 'MANUAL';
    a.startTime = nowIso;
    a.endTime = null;
    a.reservePricePerKg = reserve;
    a.minIncrementPerKg = inc;
    delete a.highestBid; // clear previous winner/bid

    a.reopenedBy = this._userId ? this._userId(ctx) : 'unknown';
    a.reopenedAt = nowIso;

    await ctx.stub.putState(aKey, Buffer.from(JSON.stringify(a)));
    await ctx.stub.setEvent('AuctionReopened', Buffer.from(JSON.stringify(a)));
    return `✅ Auction reopened for ${lotId} (manual close)`;
  }

  // --- Create fresh auction (no prior doc) ---
  const auction = {
    type: 'auction',
    lotId,
    openedBy: this._userId ? this._userId(ctx) : 'unknown',
    status: 'OPEN',
    timePolicy: 'MANUAL',
    startTime: nowIso,
    endTime: null,
    highestBid: null,
    reservePricePerKg: reserve,
    minIncrementPerKg: inc
  };

  await ctx.stub.putState(aKey, Buffer.from(JSON.stringify(auction)));
  await ctx.stub.setEvent('AuctionOpened', Buffer.from(JSON.stringify(auction)));
  return `✅ Auction opened for ${lotId} (manual close)`;
}

  
  // ====================== MARKET OFFERS ======================
  async placeBid(ctx, lotId, pricePerKg, fundingSource) {
  // 1) MSP gate
  this._requireOrg(ctx, 'WholesalersMSP');

  // 2) Identity details (for audit + key namespace)
  const msp = ctx.clientIdentity.getMSPID();
  const bidderId = this._userId ? this._userId(ctx)
                 : (ctx.clientIdentity.getAttributeValue('hf.EnrollmentID') || 'unknown');

  // (Optional) attr-based check if you issue it on certs
  // const role = ctx.clientIdentity.getAttributeValue('role');
  // if (role !== 'wholesaler') throw new Error('Only wholesaler role may bid');

  // Load auction
  const aKey = ctx.stub.createCompositeKey('auction', [lotId]);
  const aBytes = await ctx.stub.getState(aKey);
  if (!aBytes?.length) throw new Error('Auction not found');
  const a = JSON.parse(aBytes.toString());
  if (a.status !== 'OPEN') throw new Error('Auction is not OPEN');

  // Time enforcement (deterministic)
  const ledgerNow = await this._simNowISO(ctx);

  if (a.timePolicy !== 'MANUAL' && a.endTime && ledgerNow > new Date(a.endTime)) {
    throw new Error('Auction already ended');
  }

  // Load lot
  const lotKey = ctx.stub.createCompositeKey('lot', [lotId]);
  const lotBytes = await ctx.stub.getState(lotKey);
  if (!lotBytes?.length) throw new Error('Lot not found');
  const lot = JSON.parse(lotBytes.toString());

  // Validate bid
  const p = Number(pricePerKg);
  if (!Number.isFinite(p) || p <= 0) throw new Error('Invalid bid');

  const minInc = Number(a.minIncrementPerKg || 0);
  if (a.highestBid) {
    const minNext = Number(a.highestBid.pricePerKg) + (Number.isFinite(minInc) ? minInc : 0);
    if (p < minNext) throw new Error(`Bid must be at least ${minNext}`);
  } else if (a.reservePricePerKg != null && p < Number(a.reservePricePerKg)) {
    throw new Error(`First bid must meet reserve ≥ ${a.reservePricePerKg}`);
  }

  const total = Number((p * Number(lot.weightKg)).toFixed(2));

  // Funding source
  const validSources = ['SELF', 'FINANCE'];
  const src = String(fundingSource || '').toUpperCase();
  if (!validSources.includes(src)) {
    throw new Error(`Invalid funding source. Must be one of: ${validSources.join(', ')}`);
  }

  // Record bid row (include MSP to avoid cross-org ID collisions)
  const ts = ledgerNow
  const bid = {
    type: 'bid',
    lotId,
    bidderId,
    bidderMSP: msp,                   // <-- NEW: store MSP
    pricePerKg: p,
    totalAmount: total,
    fundingSource: src,
    ts
  };

  // Key: bid~lotId~MSP:user:ts (unique + namespaced by MSP)
  const bKey = ctx.stub.createCompositeKey('bid', [lotId, `${msp}:${bidderId}:${ts}`]);
  await ctx.stub.putState(bKey, Buffer.from(JSON.stringify(bid)));

  // Update highest bid (keep MSP too)
  a.highestBid = { bidderId, bidderMSP: msp, pricePerKg: p, totalAmount: total, fundingSource: src, ts };
  await ctx.stub.putState(aKey, Buffer.from(JSON.stringify(a)));
  await ctx.stub.setEvent('NewHighestBid', Buffer.from(JSON.stringify({ lotId, ...a.highestBid })));

  return `✅ Highest bid now ₹${p}/kg (total ₹${total}) [${src}]`;
}



async closeAuction(ctx, lotId) {
  this._requireOrg(ctx, 'AuctioncentersMSP'); // still limit to AuctionCenters
  const userId = this._userId(ctx);           // e.g., "User3"

  const aKey = ctx.stub.createCompositeKey('auction', [lotId]);
  const aBytes = await ctx.stub.getState(aKey);
  if (!aBytes?.length) throw new Error('Auction not found');
  const a = JSON.parse(aBytes.toString());

  if (a.status !== 'OPEN') return `ℹ️ Auction already ${a.status}`;

  // 🔒 Only the opener can close
  if (a.openedBy !== userId) {
    throw new Error(`Only the opener (${a.openedBy}) can close this auction`);
  }

  const lotKey = ctx.stub.createCompositeKey('lot', [lotId]);
  const lot = JSON.parse((await ctx.stub.getState(lotKey)).toString());

  // Annotate close metadata (deterministic time)
  a.status = 'CLOSED';
  a.closedBy = userId;
  a.closedAt = await this._simNowISO(ctx);

  if (!a.highestBid) {
    await ctx.stub.putState(aKey, Buffer.from(JSON.stringify(a)));
    await ctx.stub.setEvent(
      'AuctionClosed',
      Buffer.from(JSON.stringify({ lotId, result: 'NO_BIDS', closedBy: userId }))
    );
    return `✅ Auction closed by ${userId}. No bids for ${lotId}`;
  }

  // Winner path
  
  lot.status = 'BID';
  lot.soldAt = await this._simNowISO(ctx); // deterministic
  lot.totalPrice = a.highestBid.totalAmount;
  lot.acceptedOffer = {
    wholesalerId: a.highestBid.bidderId,
    offerPrice: a.highestBid.pricePerKg,
    totalAmount: a.highestBid.totalAmount
  };

  await ctx.stub.putState(lotKey, Buffer.from(JSON.stringify(lot)));
  await ctx.stub.putState(aKey,  Buffer.from(JSON.stringify(a)));
  await ctx.stub.setEvent(
    'AuctionClosed',
    Buffer.from(JSON.stringify({ lotId, winner: a.highestBid, closedBy: userId }))
  );

  return `✅ Auction closed by ${userId}. Winner ${a.highestBid.bidderId} @ ₹${a.highestBid.pricePerKg}/kg`;
}

// Farmer reviews the winning bid for a lot: decision = "ACCEPT" or "REJECT"
async farmerReviewBidForLot(ctx, lotId, decision) {
  this._logInvocation("farmerReviewBidForLot", arguments, ctx);
  this._requireOrg(ctx, 'FarmersMSP');

  const dec = String(decision || '').toUpperCase();
  if (!['ACCEPT', 'REJECT'].includes(dec)) {
    throw new Error("decision must be 'ACCEPT' or 'REJECT'");
  }

  // --- Load lot ---
  const lotKey = ctx.stub.createCompositeKey('lot', [lotId]);
  const lotBytes = await ctx.stub.getState(lotKey);
  if (!lotBytes?.length) throw new Error('Lot not found');
  const lot = JSON.parse(lotBytes.toString());

  // Only the lot's farmer can decide
  

  const callerId = this._userId ? this._userId(ctx) : ctx.clientIdentity.getID();
  if (lot.farmerId && lot.farmerId !== callerId) {
    console.error('REVIEW_GUARD', { lotId, expectedFarmer: lot.farmerId, caller: this._userId(ctx), msp: ctx.clientIdentity.getID() });
    throw new Error(`Only the farmer '${lot.farmerId}'  '${callerId}' can review this lot`);
  }

  // Lot must be awaiting farmer decision
  if (lot.status !== 'BID') {
    throw new Error(`Lot status must be 'BID' to review (current: '${lot.status}')`);
  }

  // --- Load auction ---
  const aKey = ctx.stub.createCompositeKey('auction', [lotId]);
  const aBytes = await ctx.stub.getState(aKey);
  if (!aBytes?.length) throw new Error('Auction not found for this lot');
  const auction = JSON.parse(aBytes.toString());

  if (auction.status !== 'CLOSED') {
    throw new Error(`Auction must be 'CLOSED' to review (current: '${auction.status}')`);
  }
  if (!auction.highestBid) throw new Error('No highestBid to review');

  // --- Apply decision ---
            // simulation-aware


  const nowIso = await this._simNowISO(ctx);
// …use nowIso directly


  if (dec === 'ACCEPT') {
    lot.status = 'BID-ACCEPTED';
    lot.acceptedByFarmerAt = nowIso;
    // keep auction CLOSED; winner stands
  } else { // REJECT
    lot.status = 'BID-REJECTED';
    lot.rejectedByFarmerAt = nowIso;

    // Re-open auction for new bids
    auction.status = 'OPEN';
    auction.reopenedByFarmer = true;
    auction.reopenedAt = nowIso;

    // Optional: clear previous winner to allow fresh bidding
    delete auction.highestBid;
  }

  // --- Persist ---
  await ctx.stub.putState(lotKey, Buffer.from(JSON.stringify(lot)));
  await ctx.stub.putState(aKey, Buffer.from(JSON.stringify(auction)));

  // --- Event ---
  const evt = { lotId, decision: dec, lotStatus: lot.status, auctionStatus: auction.status, at: nowIso };
  await ctx.stub.setEvent('FarmerReviewedBid', Buffer.from(JSON.stringify(evt)));

  return JSON.stringify(evt);
}

// Pay farmer for a lot. Prefer APPROVED finance request; otherwise pay from wholesaler wallet.
// Wholesaler pays the farmer for a lot.
// If an APPROVED finance request exists: FinanciersMSP.<financierId> -> FarmersMSP.<farmerId>
// Else: WholesalersMSP.<bidderId>       -> FarmersMSP.<farmerId>
// Wholesaler pays the farmer for a lot.
// Finance path (if APPROVED): financiers.<financierId> -> farmers.<farmerId>
// Wallet path:                 wholesalers.<bidderId>  -> farmers.<farmerId>



async reviewFinanceRequest(ctx, requestId, approve, note = '', aprPctInput = '') {
  this._logInvocation("reviewFinanceRequest", arguments, ctx);
  this._requireOrg(ctx, 'FinanciersMSP');

  // direct key first (make sure attributes are an array)
  let key = ctx.stub.createCompositeKey('financeReq', [String(requestId)]);
  let bytes = await ctx.stub.getState(key);

  // fallback: scan all financeReq and match embedded requestId
  if (!bytes?.length) {
    const iter = await ctx.stub.getStateByPartialCompositeKey('financeReq', []);
    const rows = await this._drainIteratorKV(iter); // <-- add this.
    for (const { key: k, value } of rows) {
      try {
        const rec = JSON.parse(value);
        if (rec?.requestId === requestId) { key = k; bytes = Buffer.from(JSON.stringify(rec)); break; }
      } catch {}
    }

  }
  if (!bytes?.length) throw new Error(`Finance request not found for requestId ${requestId}`);

  const req = JSON.parse(bytes.toString());
  if (req.status !== 'PENDING') throw new Error(`Request ${requestId} is not PENDING (current: ${req.status})`);

  const callerId = this._clientId ? this._clientId(ctx) : 'unknown';
  if (String(req.financierId || '') !== String(callerId)) {
    throw new Error(`Only financier ${req.financierId} can review this request`);
  }

  const decision = String(approve).toLowerCase() === 'true';
  const hasAprInput = aprPctInput !== undefined && aprPctInput !== null && String(aprPctInput).trim() !== '';
  if (decision && hasAprInput) {
    const rawApr = Number(aprPctInput);
    if (!Number.isFinite(rawApr) || rawApr <= 0) {
      throw new Error('APR must be a positive number');
    }

    const aprPct = rawApr <= 1 ? rawApr * 100 : rawApr;
    if (!Number.isFinite(aprPct) || aprPct <= 0 || aprPct > 100) {
      throw new Error('APR must be between 0 and 100 percent');
    }

    const principal = Number(req.principalAmount || 0);
    const tenorDays = Number(req?.pricing?.tenorDays || 0);
    const feePct = Number(req?.pricing?.feePct || 0);
    if (!Number.isFinite(principal) || principal <= 0) throw new Error('Finance request has invalid principalAmount');
    if (!Number.isFinite(tenorDays) || tenorDays <= 0) throw new Error('Finance request has invalid tenorDays');

    const roundMoney = Number.isFinite(Number(req?.pricing?.roundMoney)) ? Number(req.pricing.roundMoney) : 2;
    const feeAmt = this._round(principal * (feePct / 100), roundMoney);
    const interestAmt = this._round(principal * (aprPct / 100) * (tenorDays / 365), roundMoney);
    const totalPayable = this._round(principal + feeAmt + interestAmt, roundMoney);
    const previousAprPct = Number(req?.pricing?.annualInterestPct);

    req.pricing = {
      ...(req.pricing || {}),
      annualInterestPct: Number(aprPct.toFixed(2)),
      aprEnteredByFinancier: true,
      aprEnteredAt: new Date().toISOString()
    };
    req.computed = {
      ...(req.computed || {}),
      feeAmt,
      interestAmt,
      totalPayable
    };
    req.outstanding = totalPayable;
    req.termsSnapshot = {
      ...(req.termsSnapshot || {}),
      aprSource: 'FINANCIER_INPUT',
      previousAprPct: Number.isFinite(previousAprPct) ? previousAprPct : null
    };
  }

  req.status = decision ? 'APPROVED' : 'REJECTED';
  req.reviewedAt = new Date().toISOString();
  req.reviewerId = callerId;
  req.reviewerNote = note || '';

  await ctx.stub.putState(key, Buffer.from(JSON.stringify(req)));
  await ctx.stub.setEvent('FinanceRequestReviewed', Buffer.from(JSON.stringify({ requestId: req.requestId, status: req.status })));
  return `✅ Request ${req.requestId} ${req.status}${note ? `: ${note}` : ''}`;
}


// Financier’s inbox
// List all finance requests addressed to the calling financier.
// onlyPending: 'true' | 'false' (string, default 'true')
async approveFinanceRequestWithAPR(ctx, requestId, aprPct, note = '') {
  this._logInvocation("approveFinanceRequestWithAPR", arguments, ctx);
  return this.reviewFinanceRequest(ctx, requestId, 'true', note, aprPct);
}

async listIncomingFinanceRequests(ctx, onlyPending = 'true') {
  this._logInvocation("listIncomingFinanceRequests", arguments, ctx);
  this._requireOrg(ctx, 'FinanciersMSP');

  const financierId = this._clientId ? this._clientId(ctx) : 'unknown';
  const only = String(onlyPending).trim().toLowerCase() === 'true';

  // Scan all financeReq records (LevelDB-safe; helper will close the iterator)
  const iter = await ctx.stub.getStateByPartialCompositeKey('financeReq', []);
  const rows = await this._drainIteratorKV(iter);

  const out = [];
  for (const { value } of rows) {
    try {
      const rec = JSON.parse(value);
      if (!rec) continue;
      if (String(rec.financierId) !== String(financierId)) continue;
      if (only && String(rec.status) !== 'PENDING') continue;
      out.push(rec);
    } catch {
      // ignore malformed rows
    }
  }

  // (Optional) stable ordering if timestamps exist
  try {
    out.sort((a, b) => new Date(b.requestedAt || b.createdAt || 0) - new Date(a.requestedAt || a.createdAt || 0));
  } catch { /* no-op */ }

  return JSON.stringify(out);
}


async payFarmerForLot(ctx, lotId) {
  this._logInvocation("payFarmerForLot", arguments, ctx);
  this._requireOrg(ctx, 'WholesalersMSP');
  if (!lotId) throw new Error('lotId is required');

  const txId    = ctx.stub.getTxID();
  const nowIso  = await this._simNowISO(ctx);
  const callerId = this._userId(ctx); // winner (wholesaler)

  // --- Load lot & auction ---
  const lotKey = ctx.stub.createCompositeKey('lot', [String(lotId)]);
  const lotBytes = await ctx.stub.getState(lotKey);
  if (!lotBytes?.length) throw new Error('Lot not found');
  const lot = JSON.parse(lotBytes.toString());

  const aKey = ctx.stub.createCompositeKey('auction', [String(lotId)]);
  const aBytes = await ctx.stub.getState(aKey);
  if (!aBytes?.length) throw new Error('Auction not found for this lot');
  const auction = JSON.parse(aBytes.toString());

  // --- Preconditions ---
  if (lot.status !== 'BID-ACCEPTED') {
    throw new Error(`Lot must be 'BID-ACCEPTED' (current: ${lot.status})`);
  }
  if (auction.status !== 'CLOSED') {
    throw new Error(`Auction must be 'CLOSED' (current: ${auction.status})`);
  }
  if (!auction.highestBid) throw new Error('No highest bid recorded');

  const { bidderId, totalAmount: totalAmtRaw } = auction.highestBid;
  if (callerId !== bidderId) {
    throw new Error(`Only the winning bidder (${bidderId}) may pay for lot ${lotId}`);
  }

  const farmerId = lot.farmerId || lot.ownerId || lot.submitterId;
  if (!farmerId) throw new Error('Cannot determine farmerId for this lot');

  // --- Idempotency ---
  const payKey = ctx.stub.createCompositeKey('payment', [String(lotId), String(bidderId)]);
  const prev = await ctx.stub.getState(payKey);
  if (prev?.length) {
    const doc = JSON.parse(prev.toString());
    if (doc.status === 'SUCCESS') return JSON.stringify({ info: 'already-paid', ...doc });
  }

  // --- Finance request? (APPROVED only) ---
  const reqKey   = ctx.stub.createCompositeKey('financeReq', [String(lotId), String(bidderId)]);
  const reqBytes = await ctx.stub.getState(reqKey);
  const finReq   = reqBytes?.length ? JSON.parse(reqBytes.toString()) : null;

  const auctionAmt = Number(totalAmtRaw);
  if (!Number.isFinite(auctionAmt) || auctionAmt <= 0) {
    throw new Error(`Invalid auction amount: ${totalAmtRaw}`);
  }

  // Pull terms safely (principal/fee/interest conventions)
  let principal  = Number(finReq?.principalAmount );
  const feePct   = Number(finReq?.pricing?.feePct);           // percent (e.g., 1.25)
  const aprPct   = Number(finReq?.pricing?.annualInterestPct); // percent (e.g., 12)
  const tenorDays = Number(finReq?.pricing?.tenorDays);

  if (!Number.isFinite(principal) || principal <= 0) {
    principal = auctionAmt; // fallback
  }

  // Prefer precomputed values if present
  const computed = finReq?.computed || {};
  let feeAmt       = Number(computed.feeAmt);
  let interestAmt  = Number(computed.interestAmt);
  let totalPayable = Number(computed.totalPayable);

  // Fallback computations (with correct percent handling)
  if (!Number.isFinite(feeAmt) && Number.isFinite(feePct)) {
    feeAmt = (feePct / 100) * principal;                                  // <-- FIX
  }
  if (!Number.isFinite(interestAmt) && Number.isFinite(aprPct) && Number.isFinite(tenorDays)) {
    interestAmt = principal * (aprPct / 100) * (tenorDays / 365);
  }
  if (!Number.isFinite(totalPayable)) {
    totalPayable = principal
                 + (Number.isFinite(interestAmt) ? interestAmt : 0)
                 + (Number.isFinite(feeAmt) ? feeAmt : 0);
  }

  // Round money once
  const r2 = (v) => Number(Number(v).toFixed(2));
  principal    = r2(principal);
  feeAmt       = r2(feeAmt || 0);
  interestAmt  = r2(interestAmt || 0);
  totalPayable = r2(totalPayable);

  // ---------- Branch 1: NO finance (or not approved) ----------
  if (!finReq || String(finReq.status).toUpperCase() !== 'APPROVED') {
    const amount = r2(auctionAmt);
    // Wallet handles
    const fromOrg = 'wholesalers', fromUser = bidderId;
    const toOrg   = 'farmers',     toUser   = farmerId;

    // Balance check
    const fromBal = await this._computeWalletBalance(ctx, fromOrg, fromUser);
    if (fromBal < amount) throw new Error(`❌ ${fromOrg} ${fromUser} has insufficient balance. ₹${fromBal} < ₹${amount}`);

    // Transfer full auction amount
    await this._transfer(ctx, fromOrg, fromUser, toOrg, toUser, String(amount));

    // Update lot & auction
    lot.status = 'SOLD';
    lot.paidBy = bidderId;
    lot.paidAt = nowIso;
    lot.ownerId = bidderId;
    lot.wholesalerId = bidderId;
    await ctx.stub.putState(lotKey, Buffer.from(JSON.stringify(lot)));

    auction.paid = true;
    auction.paidTx = txId;
    auction.paidAt = nowIso;
    await ctx.stub.putState(aKey, Buffer.from(JSON.stringify(auction)));

    const payment = {
      docType: 'payment',
      lotId: String(lotId),
      amount,
      source: 'WALLET',
      financierId: null,
      from: `wholesalers.${fromUser}`,
      to:   `farmers.${toUser}`,
      bidderId,
      farmerId,
      txId,
      at: nowIso,
      status: 'SUCCESS'
    };
    await ctx.stub.putState(payKey, Buffer.from(JSON.stringify(payment)));
    await ctx.stub.setEvent('PaymentToFarmer', Buffer.from(JSON.stringify(payment)));
    return JSON.stringify(payment);
  }

  // ---------- Branch 2: Finance APPROVED ----------
  const financierId = String(finReq.financierId || '').trim();
  if (!financierId) throw new Error('Finance request missing financierId');
  if (!Number.isFinite(tenorDays) || tenorDays <= 0) throw new Error('Finance request missing tenorDays');

  // Net disbursement = principal - fee (fee withheld)
  const netToFarmer = r2(principal - feeAmt);
  if (!Number.isFinite(netToFarmer) || netToFarmer <= 0) {
    throw new Error(`Computed net disbursement is invalid: principal=${principal}, fee=${feeAmt}`);
  }

  // Wallet handles
  const fromOrg = 'financiers', fromUser = financierId;
  const toOrg   = 'farmers',    toUser   = farmerId;

  // Check financier balance for NET
  const finBal = await this._computeWalletBalance(ctx, fromOrg, fromUser);
  if (finBal < netToFarmer) {
    throw new Error(`❌ financiers ${fromUser} has insufficient balance. ₹${finBal} < ₹${netToFarmer}`);
  }

  // Transfer NET to farmer
  await this._transfer(ctx, fromOrg, fromUser, toOrg, toUser, String(netToFarmer));

  // Compute due date and mark finance state for EGT
  const addDays = (iso, d) => {
    const dt = new Date(iso);
    dt.setUTCDate(dt.getUTCDate() + Number(d));
    return dt.toISOString();
  };
  const dueAtIso = addDays(nowIso, tenorDays);

  const outstandingBase = totalPayable;                  // P+I+F
  const outstandingAfterFee = r2(outstandingBase); // P+I

  finReq.status = 'DISBURSED';
  finReq.disbursedAt = nowIso;
  finReq.disbursedTx = txId;
  finReq.dueAt = dueAtIso;                               // <-- NEW (needed by reconciler)
  finReq.egtDecided = false;                             // ensure reconciler will process later
  finReq.disbursement = {
    principal,
    feeDeducted: feeAmt,
    netToFarmer
  };
  finReq.outstanding = outstandingBase;
  await ctx.stub.putState(reqKey, Buffer.from(JSON.stringify(finReq)));

  // Update lot & auction
  lot.status = 'SOLD';
  lot.paidBy = bidderId;
  lot.paidAt = nowIso;
  lot.ownerId = bidderId;
  lot.wholesalerId = bidderId;
  await ctx.stub.putState(lotKey, Buffer.from(JSON.stringify(lot)));

  auction.paid  = true;
  auction.paidTx = txId;
  auction.paidAt = nowIso;
  await ctx.stub.putState(aKey, Buffer.from(JSON.stringify(auction)));

  const payment = {
    docType: 'payment',
    lotId: String(lotId),
    amount: netToFarmer,
    source: 'FINANCE',
    financierId,
    from: `financiers.${fromUser}`,
    to:   `farmers.${toUser}`,
    bidderId,
    farmerId,
    txId,
    at: nowIso,
    status: 'SUCCESS',
    financeBreakup: {
      principal,
      feeDeducted: r2(feeAmt),
      netToFarmer,
      interestPlanned: r2(interestAmt),
      totalPayableSnapshot: r2(totalPayable),
      outstandingAfterDisbursement: r2(outstandingAfterFee),
      tenorDays,
      dueAt: dueAtIso
    }
  };
  await ctx.stub.putState(payKey, Buffer.from(JSON.stringify(payment)));
  await ctx.stub.setEvent('PaymentToFarmer', Buffer.from(JSON.stringify(payment)));
  return JSON.stringify(payment);
}



// ====================== PACKING ======================

async packLotIntoPackets(ctx, lotId, sizesJson, percentagesJson, pricesJson, packingVideoHash) {
  this._logInvocation("packLotIntoPackets", arguments, ctx);
  console.log("🚀 Function `packLotIntoPackets` invoked");
  this._requireOrg(ctx, 'WholesalersMSP');

  // --- Load lot ---
  const lotKey = ctx.stub.createCompositeKey('lot', [lotId]);
  const lotBytes = await ctx.stub.getState(lotKey);
  if (!lotBytes || lotBytes.length === 0) throw new Error('Lot not found');
  const lot = JSON.parse(lotBytes.toString());

  if (lot.status === 'PACKED') {
    throw new Error(`Lot ${lotId} already packed`);
  }
  if (lot.status !== 'SOLD') {
    throw new Error('Lot must be APPROVED or SOLD to be packed');
  }

  // --- Parse and validate flexible inputs ---
  let sizes, percentages, prices;
  try {
    sizes = JSON.parse(sizesJson);          // array of numbers (grams)
    percentages = JSON.parse(percentagesJson); // array OR object
    prices = JSON.parse(pricesJson);        // object { "1000": 1200, ... }
  } catch (e) {
    throw new Error(`Invalid JSON for sizes/percentages/prices: ${e.message}`);
  }

  if (!Array.isArray(sizes) || sizes.length === 0) {
    throw new Error("sizesJson must be a non-empty JSON array of packet sizes in grams");
  }
  if (typeof prices !== 'object' || prices === null) {
    throw new Error("pricesJson must be a JSON object mapping size->price");
  }

  // normalize: sizes as integers, unique, sorted desc (larger first helps remainder handling)
  sizes = [...new Set(sizes.map(n => parseInt(n, 10)))].filter(n => n > 0).sort((a,b)=>b-a);
  if (sizes.length === 0) throw new Error("No valid packet sizes provided");

  // Build a percentage map keyed by size as string
  const pctBySize = {};
  if (Array.isArray(percentages)) {
    if (percentages.length !== sizes.length) {
      throw new Error("If percentagesJson is an array, it must be the same length as sizesJson");
    }
    sizes.forEach((sz, i) => {
      const v = Number(percentages[i]);
      if (!(v >= 0)) throw new Error("Percentages must be non-negative numbers");
      pctBySize[String(sz)] = v;
    });
  } else if (typeof percentages === 'object' && percentages !== null) {
    sizes.forEach(sz => {
      const v = Number(percentages[String(sz)]);
      if (!(v >= 0)) throw new Error(`Missing/non-numeric percentage for size ${sz}`);
      pctBySize[String(sz)] = v;
    });
  } else {
    throw new Error("percentagesJson must be a JSON array or an object keyed by size");
  }

  // Validate sum ≈ 100
  const pctSum = Object.values(pctBySize).reduce((a,b)=>a+Number(b),0);
  if (Math.abs(pctSum - 100) > 1e-6) {
    throw new Error(`Percentages must sum to 100. Got ${pctSum}`);
  }

  // Validate prices for all sizes
  sizes.forEach(sz => {
    const p = prices[String(sz)];
    if (!(Number(p) > 0)) throw new Error(`Missing/invalid price for size ${sz}g`);
  });

  // --- Compute counts per size based on total grams and percentage split ---
  const totalWeightGrams = Math.floor((lot.weightKg || 0) * 1000);
  if (!(totalWeightGrams > 0)) throw new Error("Lot weightKg must be > 0 to pack");

  const countsBySize = {};
  let usedGrams = 0;
  sizes.forEach(sz => {
    const gramsForThisSize = Math.floor(totalWeightGrams * (pctBySize[String(sz)] / 100));
    const count = Math.floor(gramsForThisSize / sz);
    countsBySize[String(sz)] = count;
    usedGrams += count * sz;
  });

  // Distribute any remaining grams greedily into smallest size if possible
  let remainder = totalWeightGrams - usedGrams;
  const smallest = sizes[sizes.length - 1];
  while (remainder >= smallest) {
    countsBySize[String(smallest)] += 1;
    remainder -= smallest;
  }

  // --- Create packets ---
  let counter = 1;
  const packetCounts = {};
  const now = new Date().toISOString();
  const putOps = [];

  for (const sz of sizes) {
    const sizeKey = String(sz);
    packetCounts[`${sz}g`] = 0;

    const howMany = countsBySize[sizeKey] || 0;
    for (let i = 0; i < howMany; i++) {
      const packetId = `${lotId}-PKT-${counter}`;
      const packetKey = ctx.stub.createCompositeKey('packet', [packetId]);

      const packet = {
        packetId,
        lotId: lotId,
        weight: `${sz}g`,
        wholesalePrice: parseFloat(prices[sizeKey]),
        qrCode: packetId,
        lotRef: lotId,
        status: 'AVAILABLE_FOR_RETAIL',
        packedAt: now,
        videoHash: {
          testing: lot.videoHash || null,
          packing: packingVideoHash
        },
        trace: {
          farmerId: lot.farmerId,
          submittedAt: lot.submittedAt || null,
          aggregatorId: lot.aggregatorId || null,
          wholsesalerId: lot.wholesalerId || null,
          testedBy: lot.aggregatorId ? `aggregators.${lot.aggregatorId}` : null,
          testedAt: lot.testedAt || null,
          testingVideoHash: lot.videoHash || null,
          testResult: lot.testResult || null,
          packedBy: this._clientId(ctx),
          packedAt: now,
          packingVideoHash
        }
      };
      this._setPacketOwner(packet, 'wholesalers', this._clientId(ctx));


      putOps.push(ctx.stub.putState(packetKey, Buffer.from(JSON.stringify(packet))));
      counter++;
      packetCounts[`${sz}g`]++;
    }
  }

  // --- Update lot ---
  lot.packetCounts = packetCounts;
  lot.status = 'PACKED';
  lot.packingConfig = {
    sizes: sizes.map(s => `${s}g`),
    percentages: pctBySize,     // keyed by grams as string
    prices,                     // keyed by grams as string
    totalWeightGrams: totalWeightGrams,
    allocatedGrams: totalWeightGrams - remainder,
    remainderGrams: remainder
  };

  putOps.push(ctx.stub.putState(lotKey, Buffer.from(JSON.stringify(lot))));
  await Promise.all(putOps);

  return `✅ Packed ${lotId} into ${counter - 1} packets. Remainder: ${remainder} g.`;
}





// packetIdsJson: '["LOT1-PKT-1","LOT1-PKT-2", ...]'
async requestPacketPurchase(ctx, packetIdsJson, note = '') {
  this._requireOrg(ctx, 'RetailersMSP');
  const retailerId = this._clientId(ctx);

  // 1) Parse, normalize, and sort for determinism
  let arr;
  try {
    arr = JSON.parse(packetIdsJson);
    if (!Array.isArray(arr) || arr.length === 0) throw new Error('must be a non-empty array');
  } catch (e) {
    throw new Error(`packetIdsJson must be JSON array of packetIds: ${e.message}`);
  }
  const packetIds = [...new Set(arr.map(x => String(x).trim()))].filter(Boolean).sort();

  // 2) Load & validate packets, enforce single wholesaler owner
  let wholesalerId = null;
  const items = [];
  for (const pid of packetIds) {
    const pKey = ctx.stub.createCompositeKey('packet', [pid]);
    const b = await ctx.stub.getState(pKey);
    if (!b?.length) throw new Error(`Packet ${pid} not found`);
    const pkt = JSON.parse(b.toString());
    if (String(pkt.status) !== 'AVAILABLE_FOR_RETAIL') {
      throw new Error(`Packet ${pid} is not AVAILABLE (status=${pkt.status})`);
    }
    const owner = this._getPacketOwner(pkt); // {org,id}
    if (owner.org !== 'wholesalers') {
      throw new Error(`Packet ${pid} is not owned by a wholesaler (ownerOrg=${owner.org})`);
    }
    if (wholesalerId === null) wholesalerId = owner.id;
    else if (wholesalerId !== owner.id) throw new Error('All packets must share the same wholesaler');

    // Be careful to push the same fields, and only deterministic values
    items.push({
      packetId: pid,
      lotId: pkt.lotId,
      size: pkt.size,
      currentPrice: Number(pkt.price) // reading state is fine; all peers read the same
    });
  }

  // Sort items too (by packetId) to avoid map/iteration order differences
  items.sort((a, b) => a.packetId.localeCompare(b.packetId));

  // 3) Deterministic IDs and timestamps
  const txId = ctx.stub.getTxID();                 // same on all peers
  const createdAt = await this._simNowISO(ctx);


  // Use txId, NOT Date.now()
  const reqId = `PKREQ-${txId}`;
  const reqKey = ctx.stub.createCompositeKey('packetPurchaseReq', [reqId]);

  const req = {
    type: 'packetPurchaseReq',
    requestId: reqId,
    retailerId,
    wholesalerId,
    packetIds,          // already sorted
    items,              // already sorted
    note: String(note || ''),
    status: 'PENDING',
    createdAt
  };

  await ctx.stub.putState(reqKey, Buffer.from(JSON.stringify(req)));
  await ctx.stub.setEvent('PacketPurchaseRequested', Buffer.from(JSON.stringify(req)));
  return `✅ Request ${reqId} submitted for ${packetIds.length} packet(s)`;
}

/**
 * Request purchase of a SINGLE packet.
 * @param {Context} ctx
 * @param {string} packetId       - e.g., "LOT-...-PKT-9"
 * @param {string} note           - optional
 * @returns {Promise<string>}
 */
// Single-packet purchase request (wrapper around requestPacketPurchase)




// decision: 'ACCEPT' | 'REJECT'
async respondPacketPurchase(ctx, requestId, decision, note = '') {
  this._requireOrg(ctx, 'WholesalersMSP');
  const wlId = this._clientId(ctx);

  const key = ctx.stub.createCompositeKey('packetPurchaseReq', [requestId]);
  

  const b = await ctx.stub.getState(key);
  if (!b?.length) throw new Error('Request not found');

  const req = JSON.parse(b.toString());
  if (req.status !== 'PENDING') throw new Error(`Request is not PENDING (current: ${req.status})`);
  if (String(req.wholesalerId) !== String(wlId)) {
    throw new Error('Only the addressed wholesaler may respond to this request');
  }

  const dec = String(decision || '').toUpperCase();
  if (!['ACCEPT', 'REJECT'].includes(dec)) throw new Error(`decision must be ACCEPT or REJECT`);

  if (dec === 'REJECT') {
    req.status = 'REJECTED';
    req.reviewerNote = String(note || '');
    req.reviewedAt = await this._simNowISO(ctx);
    await ctx.stub.putState(key, Buffer.from(JSON.stringify(req)));
    await ctx.stub.setEvent('PacketPurchaseRejected', Buffer.from(JSON.stringify({ requestId })));
    return `🚫 Request ${requestId} rejected`;
  }

  // ACCEPT: transfer ownership of all packets wholesaler -> retailer (no payments yet)
  const now = await this._simNowISO(ctx);
  let moved = 0;

  for (const pid of req.packetIds) {
    const pKey = ctx.stub.createCompositeKey('packet', [pid]);
    const bPkt = await ctx.stub.getState(pKey);
    if (!bPkt?.length) throw new Error(`Packet ${pid} not found during accept`);

    const pkt = JSON.parse(bPkt.toString());
    if (String(pkt.status) !== 'AVAILABLE_FOR_RETAIL') {
      throw new Error(`Packet ${pid} no longer AVAILABLE`);
    }

    const { org, id } = this._getPacketOwner(pkt);
    if (org !== 'wholesalers' || String(id) !== String(wlId)) {
      throw new Error(`Packet ${pid} is no longer owned by this wholesaler`);
    }

    // Reassign to retailer, keep same status/price for now
    this._setPacketOwner(pkt, 'retailers', req.retailerId);
    pkt.transferredAt = now;
    pkt.trace = pkt.trace || {};
    pkt.trace.transferredToRetailerAt = now;
    pkt.trace.transferredToRetailerBy = wlId;
    pkt.status = 'SOLD_TO_RETAILER'; // explicitly set

    await ctx.stub.putState(pKey, Buffer.from(JSON.stringify(pkt)));
    moved++;
  }

  req.status = 'ACCEPTED';
  req.acceptedAt = now;
  req.reviewerNote = String(note || '');
  req.movedCount = moved;
  
  await ctx.stub.putState(key, Buffer.from(JSON.stringify(req)));
  await ctx.stub.setEvent('PacketPurchaseAccepted', Buffer.from(JSON.stringify({ requestId, moved })));

  return `✅ Request ${requestId} accepted — ${moved} packet(s) transferred to retailer ${req.retailerId}`;
}



/**
 * Set a single price for all packets you own with a given weight (e.g., "500g").
 * Filters by status "AVAILABLE_FOR_RETAIL" by default; pass "ANY" to ignore status.
 */
/**
 * Set a single retail price for all packets you own of a given weight (e.g., "500g"),
 * but ONLY if their current status is exactly "SOLD_TO_RETAILER".
 * After pricing, packets become "AVAILABLE_FOR_PURCHASE".
 */
/**
 * Set retail price for all packets (owned by the caller) of a given weight,
 * only when current status === SOLD_TO_RETAILER, then flip to AVAILABLE_FOR_PURCHASE.
 */
async setRetailerPriceForWeight(ctx, weightStr, price) {
  this._requireOrg(ctx, 'RetailersMSP');
  const retailerId = this._clientId(ctx);

  const wRaw = String(weightStr ?? '').trim();
  if (!wRaw) throw new Error('weightStr is required (e.g., "500g")');
  const targetWeight = /g$/i.test(wRaw) ? wRaw : `${wRaw}g`;

  const p = Number(price);
  if (!Number.isFinite(p) || p < 0) {
    throw new Error(`price must be a non-negative number (got "${price}")`);
  }

  let updated = 0;
  const iter = await ctx.stub.getStateByPartialCompositeKey('packet', []);

  try {
    // ---- IMPORTANT: iterate with next()/close(), not for-await-of ----
    let res = await iter.next();
    while (!res.done) {
      const { key, value } = res.value || {};
      if (value && value.length) {
        const packet = JSON.parse(value.toString());
        const cur = String(packet.status).toUpperCase();
        // Must be owned by this retailer
        if (packet.owner === retailerId &&
            String(packet.weight).trim() === targetWeight &&
            (cur === 'SOLD_TO_RETAILER' || cur === 'AVAILABLE_FOR_PURCHASE')){

          packet.retailPrice = p;           // set retail price
          packet.status = 'AVAILABLE_FOR_PURCHASE';

          await ctx.stub.putState(key, Buffer.from(JSON.stringify(packet)));
          updated++;
        }
      }
      res = await iter.next();
    }
  } finally {
    if (iter?.close) await iter.close();
  }

  const payload = {
    event: 'PacketPricesUpdated',
    retailerId,
    weight: targetWeight,
    retailPrice: p,
    updated,
    fromStatus: 'SOLD_TO_RETAILER',
    newStatus: 'AVAILABLE_FOR_PURCHASE'
  };
  await ctx.stub.setEvent('PacketPricesUpdated', Buffer.from(JSON.stringify(payload)));
  return JSON.stringify(payload);
}




// ====================== PURCHASE======================




a// Replace your existing purchasePacket with this version
// ====================== PURCHASE PACKET ======================

async purchasePacket(ctx, packetId, consumerId) {
  this._logInvocation("purchasePacket", arguments, ctx);
  this._requireOrg(ctx, 'ConsumersMSP');

  const MS_PER_DAY = 86_400_000;
  const nowIso = await this._simNowISO(ctx);

  // ------- helpers -------
  const toMs = (iso, fb) => {
    const ms = Date.parse(String(iso || ''));
    return Number.isFinite(ms) ? ms : fb;
  };

  // cumulative overdue charges (penalty + extra simple interest) as of now
  const cumulativeOverdueCharges = (fr, nowIsoStr) => {
    const nowMs = Date.parse(nowIsoStr);
    const dueMs = Date.parse(fr?.dueAt || '');
    if (!Number.isFinite(dueMs) || !Number.isFinite(nowMs)) {
      return { overdueDays: 0, penaltyCum: 0, extraInterestCum: 0, totalCum: 0 };
    }
    const overdueDays = Math.max(0, Math.floor((nowMs - dueMs) / MS_PER_DAY));
    if (overdueDays <= 0) {
      return { overdueDays: 0, penaltyCum: 0, extraInterestCum: 0, totalCum: 0 };
    }
    const principal = Number(fr.principalAmount || 0);
    const penaltyPct = Number(fr.pricing?.penaltyPct || 0);           // % per overdue day
    const annualInterestPct = Number(fr.pricing?.annualInterestPct || 0); // % per year

    const penaltyCum       = (principal * penaltyPct * overdueDays) / 100;
    const extraInterestCum = (principal * (annualInterestPct / 100) * overdueDays / 365);
    const totalCum         = penaltyCum + extraInterestCum;
    return { overdueDays, penaltyCum, extraInterestCum, totalCum };
  };

  // ------- load packet -------
  const packetKey = ctx.stub.createCompositeKey('packet', [String(packetId)]);
  const packetBytes = await ctx.stub.getState(packetKey);
  if (!packetBytes?.length) throw new Error(`Packet ${packetId} not found`);
  const packet = JSON.parse(packetBytes.toString());

  // must be listed for purchase
  const statusNow = String(packet.status || '').toUpperCase();
  if (statusNow !== 'AVAILABLE_FOR_PURCHASE') {
    throw new Error(`Packet ${packetId} is not AVAILABLE_FOR_PURCHASE (current: ${packet.status})`);
  }

  // owner must be a retailer
  const owner = this._getPacketOwner ? this._getPacketOwner(packet) : { org: 'retailers', id: packet.owner };
  if (String(owner.org).toLowerCase() !== 'retailers') {
    throw new Error(`Packet ${packetId} is not owned by a retailer (ownerOrg=${owner.org})`);
  }
  const retailerId = owner.id;

  // ------- prices -------
  const consumerPrice = Number(packet.retailPrice);
  if (!Number.isFinite(consumerPrice) || consumerPrice <= 0) {
    throw new Error(`Invalid packet retailPrice: ${packet.retailPrice}`);
  }
  const baseWholesale = Number(packet.wholesalePrice);
  const hasWholesale  = Number.isFinite(baseWholesale) && baseWholesale > 0;

  // ------- lot / wholesaler (for finance linkage) -------
  const lotId = String(packet.lotRef || packet.lotId || '').trim();
  let wholesalerId = null;
  if (lotId) {
    const lotKey = ctx.stub.createCompositeKey('lot', [lotId]);
    const lotBytes = await ctx.stub.getState(lotKey);
    if (lotBytes?.length) {
      const lot = JSON.parse(lotBytes.toString());
      wholesalerId = lot.ownerId || lot?.acceptedOffer?.wholesalerId || null;
    }
  }

  // ==============================
  // 1) Consumer -> Retailer
  // ==============================
  await this._transfer(ctx, 'consumers', `${consumerId}`, 'retailers', `${retailerId}`, String(consumerPrice));

  // ==============================
  // 2) Retailer -> Wholesaler
  // ==============================
  let wholesalePaid = 0;
  if (wholesalerId && hasWholesale) {
    await this._transfer(ctx, 'retailers', `${retailerId}`, 'wholesalers', `${wholesalerId}`, String(baseWholesale));
    wholesalePaid = baseWholesale;
  }

  // ==============================
  // 3) Finance repayment (with penalties), only while DISBURSED
  // ==============================
  let financeRepay = 0;
  let financierIdUsed = null;

  if (lotId && wholesalerId) {
    const frKey = ctx.stub.createCompositeKey('financeReq', [String(lotId), String(wholesalerId)]);
    const frBytes = await ctx.stub.getState(frKey);

    if (frBytes?.length) {
      const fr = JSON.parse(frBytes.toString());
      const status = String(fr.status || '').toUpperCase();

      // Try to repay only while DISBURSED (i.e., base amount still relevant)
      if (status === 'DISBURSED') {
        const totalBase      = Number(fr?.computed?.totalPayable || 0); // principal + scheduled fee + scheduled interest
        const repaidSoFar    = Number(fr?.repaidAmt || 0);
        const baseOutstanding = Math.max(0, totalBase - repaidSoFar);

        // cumulative penalties & extra interest to date
        const { overdueDays, penaltyCum, extraInterestCum, totalCum } = cumulativeOverdueCharges(fr, nowIso);
        const alreadyAccrued = Number(fr?.penaltyAccum || 0);  // cumulative accrued so far
        const penaltyInc     = Math.max(0, totalCum - alreadyAccrued); // new accrual this sale instant

        // amount due "now" = base outstanding + newly accrued penalties
        const dueNow = baseOutstanding + penaltyInc;

        // sweep up to wholesalePaid this packet
        financeRepay = Math.min(dueNow, wholesalePaid);

        if (financeRepay > 0) {
          financierIdUsed = fr.financierId;

          // move wholesaler -> financier
          await this._transfer(
            ctx,
            'wholesalers', `${wholesalerId}`,
            'financiers', `${financierIdUsed}`,
            String(financeRepay)
          );

          // apply to base first, then to penalty component
          const appliedToBase = Math.min(financeRepay, baseOutstanding);
          const appliedToPenalty = Math.max(0, financeRepay - appliedToBase);

          // update FR fields
          fr.repaidAmt     = repaidSoFar + appliedToBase;
          fr.penaltyAccum  = alreadyAccrued + penaltyInc; // cumulative accrued (not net)
          // remaining after payment:
          const baseOutstandingAfter     = Math.max(0, totalBase - fr.repaidAmt);
          const penaltyOutstandingAfter  = Math.max(0, (fr.penaltyAccum) - (appliedToPenalty));
          fr.outstanding = baseOutstandingAfter + penaltyOutstandingAfter;

          // payment log
          fr.payments = fr.payments || [];
          fr.payments.push({
            at: nowIso,
            source: 'RETAIL_SALE',
            packetId,
            amount: financeRepay,
            overdueDays,
            penaltyCum,
            extraInterestCum
          });

          // settle if fully cleared (including penalties)
          if (fr.outstanding <= 1e-6) {
            fr.status = 'SETTLED';
            fr.settledAt = nowIso;
            fr.outstanding = 0;
          }
        }
      }

      // Always track net to wholesaler (even after settlement / even if no repay)
      const netToWh = Math.max(0, wholesalePaid - financeRepay);
      fr.wholesalePaid = (Number(fr.wholesalePaid) || 0) + netToWh;

      // persist FR
      await ctx.stub.putState(frKey, Buffer.from(JSON.stringify(fr)));

      // emit FR event (optional but useful)
      await ctx.stub.setEvent('FinanceRepayment', Buffer.from(JSON.stringify({
        lotId,
        wholesalerId,
        financierId: fr.financierId,
        repaidAmt: fr.repaidAmt || 0,
        wholesalePaid: fr.wholesalePaid || 0,
        penaltyAccum: fr.penaltyAccum || 0,
        outstanding: fr.outstanding || 0,
        status: fr.status,
        at: nowIso
      })));
    }
  }

  // ==============================
  // 4) Flip ownership & trace
  // ==============================
  if (this._setPacketOwner) this._setPacketOwner(packet, 'consumers', consumerId);
  else packet.owner = consumerId;

  packet.status = 'PURCHASED';
  packet.soldAt = nowIso;
  packet.trace = packet.trace || {};
  packet.trace.purchasedBy = consumerId;
  packet.trace.purchasedAt = nowIso;
  packet.trace.settlement = {
    retailerId,
    wholesalerId: wholesalerId || null,
    financeRepay,
    wholesalePaid,
    consumerPrice
  };

  await ctx.stub.putState(packetKey, Buffer.from(JSON.stringify(packet)));

  // sale event
  await ctx.stub.setEvent('PacketSold', Buffer.from(JSON.stringify({
    packetId,
    consumerId,
    retailerId,
    lotId,
    wholesalerId,
    consumerPrice,
    wholesalePaid,
    financeRepay,
    at: nowIso
  })));

  return JSON.stringify({
    ok: true,
    packetId,
    consumerId,
    retailerId,
    wholesalerId,
    lotId,
    consumerPrice,
    wholesalePaid,
    financeRepay,
    at: nowIso
  });
}


// Purchase multiple packets in one go (atomic).
// Args:
//   packetIdsJsonOrCsv: '["PACK-1","PACK-2",...]' OR 'PACK-1,PACK-2,...'
//   consumerId:         'User3'
// Returns: JSON { ok, total, successes:[...], failures:[...], at }
// Atomic bulk purchase with correct finance repayment accumulation
// packetIdsJsonOrCsv: '["P1","P2"]' or 'P1,P2'
// consumerId: 'User3'
// helper: incremental overdue accruals since last update


async purchasePacketsBulk(ctx, packetIdsJsonOrCsv, consumerId) {
  this._logInvocation("purchasePacketsBulk", arguments, ctx);
  this._requireOrg(ctx, 'ConsumersMSP');


  const computeOverdueIncrements = (fr, nowIsoStr) => {
  const DAY_MS = 86_400_000;
  const nowMs     = Date.parse(nowIsoStr);
  const dueMs     = Date.parse(fr?.dueAt || '');
  const updatedMs = Date.parse(fr?.updatedAt || fr?.createdAt || '');

  if (!Number.isFinite(dueMs) || !Number.isFinite(nowMs)) {
    return { overdueDaysTotal: 0, incDays: 0, interestInc: 0, penaltyInc: 0 };
  }

  const overdueDaysTotal = Math.max(0, Math.floor((nowMs - dueMs) / DAY_MS));

  // --- compute incremental overdue days since last update or due date ---
  let overdue = 0;
  if (nowMs > dueMs) {
    if (updatedMs > dueMs) {
      overdue = Math.max(0, Math.floor((nowMs - updatedMs) / DAY_MS));
    } else {
      overdue = Math.max(0, Math.floor((nowMs - dueMs) / DAY_MS));
    }
  }

  
  const incDays = Math.max(0, Math.floor((nowMs - updatedMs) / DAY_MS));

  const out  = Number(fr?.outstanding || 0);
  const apr  = Number(fr?.pricing?.annualInterestPct || 0);
  const pen  = Number(fr?.pricing?.penaltyPct || 0);

  let interestInc = out * (apr / 100) * (incDays / 365);
  let penaltyInc  = 0;

  if (overdueDaysTotal > 0) {
    penaltyInc = out * (pen / 100) * (overdue / 365);
  }

  return { overdueDaysTotal, incDays, interestInc, penaltyInc ,updatedMs, nowMs};
};


  // --- parse ids ---
  const raw = String(packetIdsJsonOrCsv || '').trim();
  if (!raw) throw new Error('packetIds required');
  const ids = raw.startsWith('[')
    ? JSON.parse(raw)
    : raw.split(',').map(s => s.trim()).filter(Boolean);

  if (!ids.length) throw new Error('No packetIds provided');
  if (ids.length > 200) throw new Error('Too many packetIds; max 200');

  const nowIso = await this._simNowISO(ctx);
  const successes = [];
  const failures  = [];

  // --- FR cache: key = `${lotId}::${wholesalerId}`; value = { key, fr }
  const frCache = new Map();
  const loadFR = async (lotId, wholesalerId) => {
    const key = ctx.stub.createCompositeKey('financeReq', [String(lotId), String(wholesalerId)]);
    const b   = await ctx.stub.getState(key);
    if (!b?.length) return { key, fr: null };
    return { key, fr: JSON.parse(b.toString()) };
  };

  // --- Precheck availability (fail fast)
  for (const packetId of ids) {
    const k = ctx.stub.createCompositeKey('packet', [String(packetId)]);
    const b = await ctx.stub.getState(k);
    if (!b?.length) { failures.push({ packetId, error: 'NOT_FOUND' }); continue; }
    const p = JSON.parse(b.toString());
    if (String(p.status || '').toUpperCase() !== 'AVAILABLE_FOR_PURCHASE') {
      failures.push({ packetId, error: `NOT_AVAILABLE (${p.status || 'N/A'})` });
    }
  }
  if (failures.length) throw new Error(`Bulk purchase aborted: ${failures.length} invalid packet(s)`);

  // --- Process each packet (atomic within this tx)
  let totalPaidByConsumer = 0;

  for (const packetId of ids) {
    const packetKey = ctx.stub.createCompositeKey('packet', [String(packetId)]);
    const packet    = JSON.parse((await ctx.stub.getState(packetKey)).toString());

    // --- Retailer owner ---
    const owner = this._getPacketOwner ? this._getPacketOwner(packet) : { org: 'retailers', id: packet.owner };
    if (String(owner.org).toLowerCase() !== 'retailers') {
      throw new Error(`Packet ${packetId} is not owned by a retailer (ownerOrg=${owner.org})`);
    }
    const retailerId = owner.id;

    // --- Prices ---
    const consumerPrice = Number(packet.retailPrice);
    if (!Number.isFinite(consumerPrice) || consumerPrice <= 0) {
      throw new Error(`Invalid packet retailPrice: ${packet.retailPrice}`);
    }
    const wholesalePrice = Number(packet.wholesalePrice);
    const hasWholesale   = Number.isFinite(wholesalePrice) && wholesalePrice > 0;

    // --- Lot/wholesaler (for finance linkage) ---
    const lotId = String(packet.lotRef || packet.lotId || '').trim();
    let wholesalerId = null;
    if (lotId) {
      const lotKey = ctx.stub.createCompositeKey('lot', [lotId]);
      const lotB   = await ctx.stub.getState(lotKey);
      if (lotB?.length) {
        const lot = JSON.parse(lotB.toString());
        wholesalerId = lot.ownerId || lot.acceptedOffer?.wholesalerId || null;
      }
    }

    // 1) Consumer → Retailer
    await this._transfer(ctx, 'consumers', `${consumerId}`, 'retailers', `${retailerId}`, consumerPrice);

    // 2) Retailer → Wholesaler (if applicable)
    let wholesalePaid = 0;
    if (wholesalerId && hasWholesale) {
      await this._transfer(ctx, 'retailers', `${retailerId}`, 'wholesalers', `${wholesalerId}`, wholesalePrice);
      wholesalePaid = wholesalePrice;
    }


  

    // 3) Finance repay (sweep from wholesaler → financier), penalties included
    let financeRepay = 0;
    let financierIdUsed = null;

    if (lotId && wholesalerId) {
      const frKeyId = `${lotId}::${wholesalerId}`;
      if (!frCache.has(frKeyId)) {
        const { key, fr } = await loadFR(lotId, wholesalerId);
        frCache.set(frKeyId, { key, fr });
      }
      const entry = frCache.get(frKeyId);

      if (entry.fr) {
        const status        = String(entry.fr.status || '').toUpperCase();
        const soldStatus    = String(entry.fr.status_sold || entry.fr.soldstatus || '').toUpperCase();
        const outstanding   = Number(entry.fr.outstanding ?? 0);
        const totalBase     = Number(entry.fr.principalAmount || 0); // base due: principal + scheduled interest (your code excludes fee from totalPayable here)
        const repaidSoFar   = Number(entry.fr.repaidAmt || 0);
        const penaltyAccum  = Number(entry.fr.penaltyAccum || 0);
        const interestAccum = Number(entry.fr.interest || 0);

        // Only attempt sweep if still disbursed and not marked ALL_SOLD
        if (outstanding > 0.01 && status === 'DISBURSED' && soldStatus !== 'ALL_SOLD') {
          const { overdueDaysTotal,incDays, interestInc, penaltyInc, updatedMs, nowMs } = computeOverdueIncrements(entry.fr, nowIso);

          // accrue incrementally
          entry.fr.penaltyAccum = penaltyAccum + penaltyInc;
          entry.fr.interest     = interestAccum + interestInc;
          entry.fr.overdue      = overdueDaysTotal;

          // amount due "now" (base + accrued - repaid)
          const dueNow = Math.max(0,
            totalBase + entry.fr.penaltyAccum + entry.fr.interest - repaidSoFar
          );

          // sweep up to wholesalePaid this packet
          financeRepay = Math.min(dueNow, wholesalePaid);

          if (financeRepay > 0) {
            financierIdUsed = entry.fr.financierId;

            // wholesaler -> financier
            await this._transfer(ctx, 'wholesalers', `${wholesalerId}`, 'financiers', `${financierIdUsed}`, financeRepay);

            // update FR fields
            entry.fr.repaidAmt   = repaidSoFar + financeRepay;
            entry.fr.outstanding = Math.max(0, dueNow - financeRepay);

            // payment line (incremental)
            entry.fr.payments = entry.fr.payments || [];
            entry.fr.payments.push({
              at: nowIso,
              source: 'RETAIL_SALE_BULK',
              packetId,
              amount: financeRepay,
              incDays,
              overdueDays: overdueDaysTotal,
              penaltyInc,
              interestInc,
              dueNowBefore: dueNow,
              outstandingAfter: entry.fr.outstanding,
              repaidBefore: repaidSoFar,
              repaidAfter: entry.fr.repaidAmt
            });

            // settle if cleared
            if (entry.fr.outstanding <= 0.01) {
              entry.fr.status    = 'SETTLED';
              entry.fr.settledAt = nowIso;
              entry.fr.outstanding = 0;
            }
          }
        }

        // Track NET to wholesaler for this sale (always)
        const netToWh = Math.max(0, wholesalePaid - financeRepay);
        entry.fr.wholesalePaid = (Number(entry.fr.wholesalePaid) || 0) + netToWh;

        // Robust P/L percents
        const principal = Number(entry.fr.principalAmount ?? entry.fr.principal ?? 0);
        const repaid    = Number(entry.fr.repaidAmt || 0);

        const pct = (num, den) => (den > 0 ? num / den : 0);
        entry.fr.wholesalerprofitpercent = pct(entry.fr.wholesalePaid - entry.fr.outstanding, principal);
        entry.fr.financierprofitpercent  = pct((repaid - principal- entry.fr.outstanding), principal);

        entry.fr.updatedAt = nowIso;
      }
    }

    // 4) Flip ownership & trace
    this._setPacketOwner ? this._setPacketOwner(packet, 'consumers', consumerId) : (packet.owner = consumerId);
    packet.status = 'PURCHASED';
    packet.soldAt = nowIso;
    packet.trace = packet.trace || {};
    packet.trace.purchasedBy = consumerId;
    packet.trace.purchasedAt = nowIso;
    packet.trace.settlement = {
      retailerId,
      wholesalerId: wholesalerId || null,
      financeRepay,
      wholesalePaid,
      consumerPrice
    };
    await ctx.stub.putState(packetKey, Buffer.from(JSON.stringify(packet)));

    totalPaidByConsumer += consumerPrice;
    successes.push({ packetId, financeRepay });
    try { await this.confirmAllPacketsSoldAndMark(ctx); } catch {}
  }

  // --- Persist all FR updates exactly once
  for (const { key, fr } of frCache.values()) {
    if (!fr) continue;
    await ctx.stub.putState(key, Buffer.from(JSON.stringify(fr)));
    await ctx.stub.setEvent('FinanceRepayment', Buffer.from(JSON.stringify({
      lotId: fr.lotId,
      wholesalerId: fr.requesterId || fr.wholesalerId,
      financierId: fr.financierId,
      outstanding: fr.outstanding || 0,
      repaidAmt: fr.repaidAmt || 0,
      wholesalePaid: fr.wholesalePaid || 0,
      penaltyAccum: fr.penaltyAccum || 0,
      interest: fr.interest || 0,
      status: fr.status,
      at: nowIso
    })));
  }

  await ctx.stub.setEvent('BulkPacketsPurchased', Buffer.from(JSON.stringify({
    consumerId: String(consumerId),
    count: successes.length,
    packetIds: ids,
    totalPaidByConsumer,
    at: nowIso
  })));

  return JSON.stringify({
    ok: true,
    total: { packets: successes.length, paidByConsumer: totalPaidByConsumer },
    successes,
    failures
  });
}

// -----------------------------------------------------------------------------
// Check if all packets for a given finance request are sold.
// If yes, mark the FR as ALL_SOLD, persist update, and emit event.
// -----------------------------------------------------------------------------
// Usage: await this._checkAndMarkAllPacketsSoldForFR(ctx, fr);
async _checkAndMarkAllPacketsSoldForFR(ctx, fr) {
  const U = s => String(s || '').toUpperCase();
  if (!fr) throw new Error('Finance request object required');

  const lotId        = String(fr.lotId || '').trim();
  const wholesalerId = String(fr.wholesalerId || fr.requesterId || '').trim();
  if (!lotId) return { ok:false, reason:'NO_LOT_ID' };

  const nowIso = this._simNowISO ? await this._simNowISO(ctx) : new Date().toISOString();

  // Define status groups
  const SOLD_SET     = new Set(['PURCHASED','SOLD']);
  const AVAIL_SET    = new Set(['AVAILABLE','AVAILABLE_FOR_PURCHASE']);
  const RESERVED_SET = new Set(['RESERVED','HELD']);
  const REJECTED_SET = new Set(['REJECTED','CANCELLED','CANCELED']);

  // --- Scan all packets belonging to this FR’s lotId ---
  let total=0, sold=0, available=0, reserved=0, rejected=0, other=0;
  const it = await ctx.stub.getStateByPartialCompositeKey('packet', []);
  try {
    while (true) {
      const r = await it.next();
      if (!r.value || !r.value.value) { if (r.done) break; continue; }
      const p = JSON.parse(r.value.value.toString('utf8'));
      const pLot = String(p?.lotRef || p?.lotId || '').trim();
      if (pLot !== lotId) { if (r.done) break; continue; }

      total++;
      const st = U(p?.status);
      if (SOLD_SET.has(st)) sold++;
      else if (AVAIL_SET.has(st))    available++;
      else if (RESERVED_SET.has(st)) reserved++;
      else if (REJECTED_SET.has(st)) rejected++;
      else other++;
      if (r.done) break;
    }
  } finally {
    await it.close();
  }

  const allSold = total > 0 && sold === total;

  // --- If already marked, skip ---
  const already = U(fr.status_sold) === 'ALL_SOLD';
  if (already) return { ok:true, already:true, allSold, total, sold };

  // --- If all packets sold, mark FR ---
  if (allSold) {
    fr.status_sold = 'ALL_SOLD';
    fr.allSoldAt   = nowIso;


    const frKey = ctx.stub.createCompositeKey('financeReq', [String(lotId), String(wholesalerId)]);
    await ctx.stub.putState(frKey, Buffer.from(JSON.stringify(fr)));

    const doneKey = ctx.stub.createCompositeKey('egt:fr:done', ['FIN', String(fr.requestId || `${lotId}::${wholesalerId}`)]);
    await ctx.stub.putState(doneKey, Buffer.from(nowIso));

    await ctx.stub.setEvent('FinanceRequestAllSold', Buffer.from(JSON.stringify({
      requestId: fr.requestId || null,
      lotId,
      wholesalerId,
      totalPackets: total,
      soldPackets: sold,
      at: nowIso
    })));

    return { ok:true, updated:true, status_sold:'ALL_SOLD', total, sold };
  }

  return { ok:true, updated:false, allSold:false, total, sold, available, reserved, rejected, other };
}



  // ====================== FEES ======================


  async setTestingFee(ctx, auctioncenterId, feeAmount) {
  this._requireOrg(ctx, 'AuctioncentersMSP');

  const id  = String(auctioncenterId || this._userId(ctx));
  const amt = Number(feeAmount);
  if (!Number.isFinite(amt) || amt < 0) throw new Error('feeAmount must be a non-negative number');

  const key = ctx.stub.createCompositeKey('testingFee', [id]);
  const rec = {
    auctioncenterId: id,
    feeAmount: amt,
    updatedAt: this._txTimeISO(ctx)     // ← deterministic across peers
  };
  await ctx.stub.putState(key, Buffer.from(JSON.stringify(rec)));
  return JSON.stringify({ ok:true, ...rec });
}

  async getTestingFee(ctx, auctioncenterId) {
    this._logInvocation("getTestingFee", arguments, ctx);
    console.log("🚀 Function `getTestingFee invoked");
    const key = ctx.stub.createCompositeKey('testingFee', [auctioncenterId]);
    const data = await ctx.stub.getState(key);
    if (!data || data.length === 0) throw new Error('Fee not set');
    return data.toString();
  }



// ====================== QUERY======================


async getPacketHistory(ctx, packetId) {
this._logInvocation("getPacketHistory", arguments, ctx);
console.log("🚀 Function `getPacketHistory` invoked");
  const packetKey = ctx.stub.createCompositeKey('packet', [packetId]);
  const iterator = await ctx.stub.getHistoryForKey(packetKey);

  const history = [];
  while (true) {
    const res = await iterator.next();
    if (res.value) {
      let parsedValue = null;

      try {
        parsedValue = JSON.parse(res.value.value.toString('utf8'));
      } catch (e) {
        parsedValue = { raw: res.value.value.toString('utf8') };
      }

      const tx = {
        txId: res.value.txId,
        timestamp: res.value.timestamp,
        isDelete: res.value.isDelete,
        action: res.value.isDelete ? "DELETED" : "UPDATED",
        packetId: packetId,
        weight: parsedValue?.weight || null,
        price: parsedValue?.price || null,
        owner: parsedValue?.owner || null,
        status: parsedValue?.status || null,
        packedAt: parsedValue?.packedAt || null,
        lotRef: parsedValue?.lotRef || null,
        videoHash: parsedValue?.videoHash || null,
        trace: parsedValue?.trace || {},
        fullRecord: parsedValue
      };

      history.push(tx);
    }

    if (res.done) break;
  }

  await iterator.close();
  return JSON.stringify(history);
}



async getFarmerRating(ctx, farmerId) {
this._logInvocation("getFarmerRating", arguments, ctx);
console.log("🚀 Function `getFarmerRating invoked");
  const iterator = await ctx.stub.getStateByPartialCompositeKey('lot', []);
  let total = 0;
  let rejected = 0;

  while (true) {
    const res = await iterator.next();
    if (res.value && res.value.value.toString()) {
      const lot = JSON.parse(res.value.value.toString());

      if (lot.farmerId === farmerId) {
        total++;
        if (lot.status === 'REJECTED') {
          rejected++;
        }
      }
    }

    if (res.done) {
      await iterator.close();
      break;
    }
  }

  const rating = total === 0 ? 0 : Math.round(((total - rejected) / total) * 100);
  return JSON.stringify({ farmerId, total, rejected, rating });
}









  
// Filtered getAllProduce
async getAllProduce(ctx, status) {
    this._logInvocation("getAllProduce", arguments, ctx);
    console.log(`🚀 Function getAllProduce invoked with status: ${status}`);

    const iterator = await ctx.stub.getStateByPartialCompositeKey('lot', []);
    const results = [];

    while (true) {
        const res = await iterator.next();
        if (res.value && res.value.value.toString()) {
            const lot = JSON.parse(res.value.value.toString('utf8'));
            if (!status || lot.status === status) {
                results.push(lot);
            }
        }
        if (res.done) break;
    }

    await iterator.close();
    return JSON.stringify(results);
}


async getLotsWithAuctions(ctx, status) {
    this._logInvocation("getLotsWithAuctions", arguments, ctx);
    console.log(`🚀 Function getLotsWithAuctions invoked with status: ${status}`);

    const iterator = await ctx.stub.getStateByPartialCompositeKey('auction', []);
    const results = [];

    while (true) {
        const res = await iterator.next();
        if (res.value && res.value.value.toString()) {
            const auction = JSON.parse(res.value.value.toString('utf8'));

            // apply status filter if provided
            if (!status || auction.status === status) {
                // fetch the lot linked to this auction
                const lotKey = ctx.stub.createCompositeKey('lot', [auction.lotId]);
                const lotBytes = await ctx.stub.getState(lotKey);

                if (lotBytes && lotBytes.length > 0) {
                    const lot = JSON.parse(lotBytes.toString('utf8'));
                    results.push({ lot, auction });
                }
            }
        }
        if (res.done) break;
    }

    await iterator.close();
    return JSON.stringify(results);
}


async getLotsWithFinanceRequests(ctx, status) {
  this._logInvocation("getLotsWithFinanceRequests", arguments, ctx);
  console.log(`🚀 Function getLotsWithFinanceRequests invoked with status: ${status}`);

  // iterate over all finance requests
  const iterator = await ctx.stub.getStateByPartialCompositeKey('financeReq', []);
  const results = [];

  while (true) {
    const res = await iterator.next();
    if (res.value && res.value.value.toString()) {
      const financeReq = JSON.parse(res.value.value.toString('utf8'));

      // apply status filter if provided (PENDING, APPROVED, etc.)
      if (!status || financeReq.status === status) {
        // fetch linked lot
        const lotKey = ctx.stub.createCompositeKey('lot', [financeReq.lotId]);
        const lotBytes = await ctx.stub.getState(lotKey);

        // fetch linked auction (optional but usually useful)
        const aKey = ctx.stub.createCompositeKey('auction', [financeReq.lotId]);
        const aBytes = await ctx.stub.getState(aKey);

        const lot = lotBytes && lotBytes.length > 0 ? JSON.parse(lotBytes.toString('utf8')) : null;
        const auction = aBytes && aBytes.length > 0 ? JSON.parse(aBytes.toString('utf8')) : null;

        results.push({
          lot,
          auction,
          financeRequest: financeReq
        });
      }
    }
    if (res.done) break;
  }

  await iterator.close();
  return JSON.stringify(results);
}



// 🔄 NEW: Filtered getAllPackets
async getAllPackets(ctx, status) {
    this._logInvocation("getAllPackets", arguments, ctx);
    console.log(`🚀 Function getAllPackets invoked with status: ${status}`);

    const iterator = await ctx.stub.getStateByPartialCompositeKey('packet', []);
    const packets = [];

    while (true) {
        const res = await iterator.next();
        if (res.value && res.value.value.toString()) {
            try {
                const packet = JSON.parse(res.value.value.toString('utf8'));
                if (!status || packet.status === status) {
                    packets.push(packet);
                }
            } catch (err) {
                console.error("❌ Failed to parse packet:", err);
            }
        }
        if (res.done) break;
    }

    await iterator.close();
    return JSON.stringify(packets);
}


async getPacketsWithRequests(ctx, statusFilter = '') {
  this._logInvocation("getPacketsWithRequests", arguments, ctx);

  const iter = await ctx.stub.getStateByPartialCompositeKey('packetPurchaseReq', []);
  const rows = await this._drainIteratorKV(iter);

  const out = [];
  const filter = statusFilter ? String(statusFilter).toUpperCase() : '';

  for (const { value } of rows) {
    try {
      const req = JSON.parse(value);
      if (!req) continue;

      // If status filter is set, skip non-matching
      if (filter && String(req.status).toUpperCase() !== filter) continue;

      // Load packets referenced in the request
      const packets = [];
      for (const pid of req.packetIds || []) {
        const pKey = ctx.stub.createCompositeKey('packet', [pid]);
        const pBytes = await ctx.stub.getState(pKey);
        if (pBytes?.length) {
          try { packets.push(JSON.parse(pBytes.toString())); } catch {}
        }
      }

      out.push({
        request: req,
        packets
      });
    } catch (e) {
      console.error("⚠️ Skipping malformed packet request:", e.message);
    }
  }

  return JSON.stringify(out);
}




async getAllFinanceRequestsEnriched(ctx) {
  this._logInvocation("getAllFinanceRequestsEnriched", arguments, ctx);

  const nowIso = new Date().toISOString();
  const results = [];

  // --- Step 1: iterate all financeReq records ---
  const iterator = await ctx.stub.getStateByPartialCompositeKey("financeReq", []);

  while (true) {
    const r = await iterator.next();
    if (r.value && r.value.value) {
      try {
        const key = r.value.key.toString();
        const fr = JSON.parse(r.value.value.toString("utf8"));

        const lotId        = fr.lotId || "";
        const wholesalerId = fr.wholesalerId || fr.requesterId || "";
        const financierId  = fr.financierId || "";
        const status       = String(fr.status || "").toUpperCase();

        // --- Step 2: collect packets belonging to this lot ---
        const packets = [];
        const packetIter = await ctx.stub.getStateByPartialCompositeKey("packet", [String(lotId)]);
        while (true) {
          const pr = await packetIter.next();
          if (pr.value && pr.value.value) {
            try {
              const packet = JSON.parse(pr.value.value.toString("utf8"));
              // only include packets that belong to this lot
              if ((packet.lotRef || packet.lotId) === lotId) {
                packets.push({
                  packetId: packet.packetId || packet._id || "",
                  status: packet.status || "",
                  retailPrice: packet.retailPrice || 0,
                  wholesalePrice: packet.wholesalePrice || 0,
                  owner: packet.owner || "",
                  soldAt: packet.soldAt || "",
                  trace: packet.trace || {}
                });
              }
            } catch (err) {
              console.error("❌ parse packet error:", err.message);
            }
          }
          if (pr.done) break;
        }
        await packetIter.close();

        // --- Step 3: compute aggregates ---
        const totalPacketsSold = packets.filter(p => String(p.status).toUpperCase() === "PURCHASED").length;
        const grossSale = packets.reduce((sum, p) => sum + Number(p.retailPrice || 0), 0);
        const wholesaleSum = packets.reduce((sum, p) => sum + Number(p.wholesalePrice || 0), 0);

        const payments = Array.isArray(fr.payments) ? fr.payments : [];
        const totalPayments = payments.length;
        const totalPaid = payments.reduce((sum, p) => sum + Number(p.amount || 0), 0);

        // --- Step 4: enrich FR with packet + summary info ---
        fr._meta = {
          key,
          lotId,
          wholesalerId,
          financierId,
          createdAt: fr.createdAt || "",
          updatedAt: fr.updatedAt || "",
          settledAt: fr.settledAt || "",
          status,
          soldStatus: String(fr.status_sold || "").toUpperCase(),
          outstanding: Number(fr.outstanding || 0),
          totalPackets: packets.length,
          packetsSold: totalPacketsSold,
          totalPaid,
          totalPayments,
          grossSale,
          wholesaleSum,
          fetchedAt: nowIso
        };

        fr._packets = packets;

        results.push(fr);
      } catch (err) {
        console.error("❌ error parsing FR:", err.message);
      }
    }
    if (r.done) break;
  }

  await iterator.close();

  return JSON.stringify({
    ok: true,
    count: results.length,
    data: results
  });
}







// Return all finance requests on the ledger (across all financiers)
// Optional filters: status, wholesalerId, lotId, limit, bookmark
async getAllFinanceRequestDetails(ctx) {
  this._logInvocation("getAllFinanceRequestDetails", arguments, ctx);

  let check = 0;
  let check1 = 0;
  let res = null;

  // --- Try to refresh all EGT scores ---
  try {
    res = await this.updateScoresAllFinanceRequests(ctx);
    check++;
  } catch (e) {
    console.error("❌ updateScoresAllFinanceRequests failed:", e.message);
    res = `updateScoresAllFinanceRequests failed: ${e.message}`;
  }

  check1++;

  // --- Fetch all finance requests from ledger ---
  const iterator = await ctx.stub.getStateByPartialCompositeKey('financeReq', []);
  const out = [];

  // --- Helper: safe full-day diff in UTC ---
  const daysDiffUtc = (fromIso, toIso) => {
    if (!fromIso || !toIso) return null;
    const clean = s => {
      const t = String(s).trim().replace(/\s+day\s+sold\s+at.*$/i, '');
      return /[zZ]|[+\-]\d{2}:\d{2}$/.test(t) ? t : (t.endsWith('Z') ? t : t + 'Z');
    };
    const a = new Date(clean(fromIso));
    const b = new Date(clean(toIso));
    if (isNaN(a) || isNaN(b)) return null;
    const ymd = d => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return Math.max(0, Math.floor((ymd(b) - ymd(a)) / 86400000));
  };

  const nowIso = new Date().toISOString();

  // --- Iterate through all financeReq records ---
  while (true) {
    const r = await iterator.next();
    if (r.value && r.value.value) {
      try {
        const rec = JSON.parse(r.value.value.toString('utf8'));

        // --- compute derived fields ---
        const soldStatus = String(rec.status_sold || '').toUpperCase();
        const hasStoredDays = Number.isFinite(Number(rec.days_taken_to_sell));
        const computedSoldDays = hasStoredDays
          ? Number(rec.days_taken_to_sell)
          : (soldStatus === 'ALL_SOLD'
              ? daysDiffUtc(rec.createdAt || rec.created, rec.allSoldAt)
              : daysDiffUtc(rec.createdAt || rec.created, nowIso));

        // --- simplified projection ---
        const short = {
          financeId:     rec.financeId || r.value.key,
          lotId:         rec.lotId || '',
          wholesalerId:  rec.wholesalerId || rec.requesterId || '',
          financierId:   rec.financierId || '',
          principal:     Number(rec.principalAmount || 0),
          interest:      Number(rec.computed?.interestAmt || rec.interestAmt || 0),
          interestActual:   Number(rec.interest  || 0),
          interestPct:   Number(rec.pricing?.annualInterestPct  || 0),
          fee:           Number(rec.computed?.feeAmt || rec.feeAmt || 0),
          repaid:        Number(rec.repaidAmt || 0),
          tenorDays:     Number(rec.pricing?.tenorDays ?? 0),
          totalPayable:  Number(rec.computed?.totalPayable || 0),
          penalty:       Number(rec.penaltyAccum || 0),
          penaltyPct:    Number(rec.pricing?.penaltyPct || 0),
          overdue:       Number(rec.overdue || 0),
          days_taken_to_sell_computed: Number(computedSoldDays ?? 0),
          days_settle:   Number(rec.days_settle || 0),
          days:          Number(rec.days || 0),
          pifin_raw:     Number(rec.pifin_raw || 0),
          finScore:      Number(rec.finScore || 0),
          whScore:       Number(rec.whScore || 0),
          outstanding:   Number(rec.outstanding || 0),
          wholesalerPaid: Number(rec.wholesalePaid || rec.paidByWholesaler || 0),
          wholesalerprofit: Number(rec.wholesalerprofitpercent || 0),
          financierprofit:  Number(rec.financierprofitpercent || 0),
          grosssale:      Number(rec.grosssale || 0),
          status:        String(rec.status || ''),
          egtstatus:     String(rec.status_egt || ''),
          soldstatus:    String(rec.status_sold || ''),
          settledAt:     rec.settledAt || '',
          createdAt:     rec.createdAt || '',
          dueAt:         rec.dueAt || '',
          allSoldAt:     rec.allSoldAt || '',
          lastUpdate:    rec.updatedAt || ''
        };

        out.push(short);
      } catch (e) {
        console.error('❌ parse error in getAllFinanceRequestDetails:', e.message);
      }
    }
    if (r.done) break;
  }

  await iterator.close();

  return JSON.stringify({
    ok: true,
    count: out.length,
    data: out,
    check,
    check1,
    res
  });
}




// async function getFinanceRequestsByFinancier(ctx, financierId, status = 'ALL') {
//   this._logInvocation("getFinanceRequestsByFinancier", arguments, ctx);

//   const fin = String(financierId || '').trim();
//   if (!fin) throw new Error('financierId is required');

//   const want = String(status || 'ALL').toUpperCase();
//   const allow = want === 'ALL' ? null : new Set([want]);

//   const nowIso = this._simNowISO ? await this._simNowISO(ctx) : new Date().toISOString();
//   const now = new Date(nowIso);

//   const LIM = 1000; // safety cap

//   // ---- helpers -------------------------------------------------------------

//   const compute = (fr) => {
//     const total = Number(fr?.computed?.totalPayable ?? 0);
//     const repaid = Number(fr?.repaidAmt ?? 0);
//     const outstanding = Math.max(0, total - repaid);

//     let daysLeft = null, overdueDays = 0;
//     if (fr?.dueAt) {
//       const due = new Date(fr.dueAt);
//       if (!isNaN(due.getTime())) {
//         daysLeft = Math.ceil((due - now) / 86400000);
//         if (daysLeft < 0) overdueDays = -daysLeft;
//       }
//     }
//     const pctRepaid      = total > 0 ? +(100 * repaid / total).toFixed(2) : (repaid > 0 ? 100 : 0);
//     const pctOutstanding = total > 0 ? +(100 * outstanding / total).toFixed(2) : 0;
//     return { total, repaid, outstanding, daysLeft, overdueDays, pctRepaid, pctOutstanding };
//   };

//   const summarize = (arr) => {
//     let totalPayable=0,totalRepaid=0,totalOutstanding=0,numOverdue=0,dueSoon=0;
//     for (const it of arr) {
//       totalPayable     += it.metrics.total;
//       totalRepaid      += it.metrics.repaid;
//       totalOutstanding += it.metrics.outstanding;
//       if (it.metrics.daysLeft !== null && it.metrics.daysLeft < 0) numOverdue++;
//       if (it.metrics.daysLeft !== null && it.metrics.daysLeft >= 0 && it.metrics.daysLeft <= 7) dueSoon++;
//     }
//     return { count: arr.length, totalPayable, totalRepaid, totalOutstanding, numOverdue, dueSoonWithin7d: dueSoon };
//   };

//   const pushIfIncluded = (rows, fr) => {
//     // status filter (if any)
//     const st = String(fr?.status || '').toUpperCase();
//     if (allow && !allow.has(st)) return;

//     // financier match
//     if (String(fr.financierId) !== fin) return;

//     const m = compute(fr);
//     rows.push({
//       requestId: fr.requestId ?? fr.id ?? fr._id ?? undefined,
//       lotId: fr.lotId ?? null,
//       wholesalerId: fr.wholesalerId ?? fr.requesterId ?? null,
//       financierId: fr.financierId ?? fin,
//       status: fr.status,
//       dueAt: fr.dueAt ?? null,
//       computed: fr.computed ?? null,
//       repaidAmt: Number(fr.repaidAmt ?? 0),
//       outstanding: m.outstanding,
//       daysLeft: m.daysLeft,
//       overdueDays: m.overdueDays,
//       pctRepaid: m.pctRepaid,
//       pctOutstanding: m.pctOutstanding,
//       paymentsCount: Array.isArray(fr.payments) ? fr.payments.length : 0,
//       metrics: m
//     });
//   };

//   // ---- main ---------------------------------------------------------------

//   const rows = [];
//   let engine = 'leveldb-scan';

//   // Prefer rich query if available (CouchDB)
//   try {
//     if (typeof ctx.stub.getQueryResult === 'function') {
//       // Note: CouchDB selector cannot filter by dynamic status set easily; we filter in JS.
//       const query = { selector: { docType: 'financeRequest', financierId: fin }, limit: LIM };
//       const it = await ctx.stub.getQueryResult(JSON.stringify(query));
//       try {
//         while (true) {
//           const r = await it.next();
//           if (r.value) {
//             // Handle both shapes: Buffer or { value: Buffer }
//             const buf = r.value.value ? r.value.value : r.value;
//             const fr = JSON.parse(buf.toString('utf8'));
//             if (String(fr.docType) !== 'financeRequest') {
//               if (r.done) break; else continue;
//             }
//             pushIfIncluded(rows, fr);
//             if (rows.length >= LIM) break;
//           }
//           if (r.done) break;
//         }
//         engine = 'couchdb-query';
//       } finally {
//         if (typeof it.close === 'function') await it.close();
//       }
//     }
//   } catch (_) {
//     // fall through to LevelDB scan
//   }

//   // Fallback: LevelDB full scan (fix: accept both buffer shapes)
//   if (engine === 'leveldb-scan') {
//     const it = await ctx.stub.getStateByPartialCompositeKey('financeRequest', []);
//     try {
//       while (true) {
//         const r = await it.next();
//         if (r.value) {
//           const buf = r.value.value ? r.value.value : r.value; // ✅ handle both shapes
//           const fr = JSON.parse(buf.toString('utf8'));

//           if (String(fr.docType) !== 'financeRequest') {
//             if (r.done) break; else continue;
//           }
//           pushIfIncluded(rows, fr);
//           if (rows.length >= LIM) break;
//         }
//         if (r.done) break;
//       }
//     } finally {
//       if (typeof it.close === 'function') await it.close();
//     }
//   }

//   const summary = summarize(rows);
//   const items = rows.map(({ metrics, ...rest }) => rest);

//   return JSON.stringify({
//     ok: true,
//     financierId: fin,
//     asOf: nowIso,
//     summary,
//     items,
//     engine
//   });
// }



//   async getStats(ctx) {
//   const lotIterator = await ctx.stub.getStateByPartialCompositeKey('lot', []);
//   const packetIterator = await ctx.stub.getStateByPartialCompositeKey('packet', []);

//   let stats = {
//     totalWeight: 0,
//     submittedLotsCount: 0,
//     rejectedWeight: 0,
//     awaitingApprovalWeight: 0,
//     approvedWeight: 0,
//     soldWeight: 0,
//     purchasedWeight: 0,
//     packedWeight: 0,
//     awaitingTestCount: 0,
//     testedApprovedLotsCount: 0,
//     rejectedLotsCount: 0,
//     createdPacketCounts: { "100": 0, "250": 0, "500": 0, "1000": 0 },
//     topFarmer: ""
//   };

//   const farmerRatings = {};

//   // ---- Process LOTS ----
//   while (true) {
//     const res = await lotIterator.next();
//     if (res.value && res.value.value.toString()) {
//       const lot = JSON.parse(res.value.value.toString('utf8'));
//       const weight = lot.weightKg || 0;

//       stats.totalWeight += weight;
//       stats.submittedLotsCount++;

//       switch (lot.status) {
//         case "SUBMITTED":
//           stats.awaitingTestCount++;
//           stats.awaitingApprovalWeight += weight;
//           break;
//         case "REJECTED":
//           stats.rejectedWeight += weight;
//           stats.rejectedLotsCount++;
//           break;
//         case "APPROVED":
//           stats.testedApprovedLotsCount++;
//           break;
//         case "purchase-requested":
  
//           stats.testedApprovedLotsCount++;
//           break;

//         case "SOLD":
//           stats.soldWeight += weight;
//           stats.testedApprovedLotsCount++;

//           case "PACKED":
//           stats.soldWeight += weight;
//           stats.testedApprovedLotsCount++;
//           break;
//       }

//       if (lot.farmerId && typeof lot.rating === "number") {
//         if (!farmerRatings[lot.farmerId]) farmerRatings[lot.farmerId] = [];
//         farmerRatings[lot.farmerId].push(lot.rating);
//       }
//     }
//     if (res.done) break;
//   }
//   await lotIterator.close();

//   // ---- Process PACKETS ----
//   while (true) {
//     const res = await packetIterator.next();
//     if (res.value && res.value.value.toString()) {
//       const packet = JSON.parse(res.value.value.toString('utf8'));

//       // Parse weight from string like "100g"
//       let weight = 0;
//       if (typeof packet.weight === "string") {
//         weight = parseInt(packet.weight.replace("g", ""));
//       }

//       stats.packedWeight += weight;

//       const size = `${weight}`;
//       if (stats.createdPacketCounts[size] !== undefined) {
//         stats.createdPacketCounts[size] += 1;
//       }

//       if (packet.status === "PURCHASED") {
//         stats.purchasedWeight += weight / 1000; // convert grams to kg
//       }
//     }
//     if (res.done) break;
//   }
//   await packetIterator.close();

//   // ---- Derived Approved Weight ----
//   stats.approvedWeight = stats.totalWeight - stats.rejectedWeight - stats.awaitingApprovalWeight;

//   // ---- Top-rated Farmer ----
//   let maxAvg = -1;
//   for (const farmerId in farmerRatings) {
//     const ratings = farmerRatings[farmerId];
//     const avg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
//     if (avg > maxAvg) {
//       maxAvg = avg;
//       stats.topFarmer = farmerId;
//     }
//   }

//   return JSON.stringify(stats);
// }

// ================== QUERY: Packets with Purchase Requests ==================








// ----------------- ----------------RECENT QUERIES ----------------------------------

  // Replace/augment your function with this
async getAllPacketsPaged(ctx, status = '', pageSize = '200', bookmark = '') {
  this._logInvocation("getAllPacketsPaged", arguments, ctx);

  const limit = Math.max(1, parseInt(pageSize, 10) || 200);
  
  // Use Fabric pagination API for composite-key scans
  const { iterator, metadata } =
    await ctx.stub.getStateByPartialCompositeKeyWithPagination('packet', [], limit, bookmark);

  const items = [];
  while (true) {
    const res = await iterator.next();
    if (res.value && res.value.value) {
      try {
        const pkt = JSON.parse(res.value.value.toString('utf8'));
        // normalize compare (optional)
        if (!status || String(pkt.status).toUpperCase() === String(status).toUpperCase()) {
          // Trim heavy fields if any (keep list payload light)
          delete pkt.history;
          delete pkt.videoHashes;
          delete pkt.largeBlobs;
          items.push(pkt);
        }
      } catch (e) {
        // swallow parse errors for robustness
      }
    }
    if (res.done) break;
  }
  await iterator.close();

  return JSON.stringify({
    items,
    fetchedRecordsCount: metadata.fetchedRecordsCount,
    bookmark: metadata.bookmark || ''
  });
}


  

// chaincode: cardamom_11.js
async getAllProducePaged(ctx, status = '', pageSize = '100', bookmark = '') {
  const page = Math.max(1, parseInt(pageSize, 10) || 100);

  // Build selector: return only lightweight fields if possible
  const selector = status
    ? { docType: 'produce', status: String(status).toUpperCase() }
    : { docType: 'produce' };

  const query = { selector }; // add sort/use_index if you have them

  const { iterator, metadata } = await ctx.stub.getQueryResultWithPagination(
    JSON.stringify(query),
    page,
    bookmark
  );

  const items = [];
  for await (const kv of iterator) {
    // Keep the payload small (remove heavy nested fields if present)
    const obj = JSON.parse(kv.value.toString('utf8'));
    // Example trimming:
    delete obj.history;
    delete obj.largeBlobs;
    items.push(obj);
  }
  await iterator.close();

  return Buffer.from(JSON.stringify({
    items,
    fetchedRecordsCount: metadata.fetchedRecordsCount,
    bookmark: metadata.bookmark || ''
  }));
}


async dummyTransaction(ctx) {
    return '✅ Dummy transaction executed';
}


async getHighestOfferForLot(ctx, lotId) {
    console.log("🚀 Function `getHighestOfferForLot` invoked");

    const iterator = await ctx.stub.getStateByPartialCompositeKey('offer', [lotId]);

    let highestOffer = null;

    while (true) {
        const res = await iterator.next();
        if (res.value && res.value.value.toString()) {
            const offer = JSON.parse(res.value.value.toString());
            if (!highestOffer || parseFloat(offer.offerPrice) > parseFloat(highestOffer.offerPrice)) {
                highestOffer = offer;
            }
        }
        if (res.done) {
            await iterator.close();
            break;
        }
    }

    // ✅ No throw — return null if no offer exists
    return JSON.stringify({ highest: highestOffer });
}


 




}

module.exports = SupplyChainContract;
