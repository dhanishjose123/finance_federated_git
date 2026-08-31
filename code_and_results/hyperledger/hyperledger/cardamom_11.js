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

  // ===========================================================================
  // Core Identity, Time, And Ledger Helpers
  // ===========================================================================

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

  _auctionId(lotId, bidRound = 1) {
    return `${String(lotId)}-offers-${String(bidRound)}`;
  }

  async _getBestOfferForAuction(ctx, auctionId) {
    const iterator = await ctx.stub.getStateByPartialCompositeKey('auctionOffer', [String(auctionId)]);
    let bestOffer = null;

    while (true) {
      const res = await iterator.next();
      if (res.value?.value) {
        try {
          const offer = JSON.parse(res.value.value.toString('utf8'));
          const price = Number(offer.pricePerKg);
          if (Number.isFinite(price) && (!bestOffer || price > Number(bestOffer.pricePerKg))) {
            bestOffer = offer;
          }
        } catch {}
      }

      if (res.done) {
        await iterator.close();
        break;
      }
    }

    return bestOffer;
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
        docType: 'wallet',
        balance: 0,
        lastUpdated: new Date().toISOString(),
        consolidationCount: 0
    };

    await ctx.stub.putState(walletKey, Buffer.from(JSON.stringify(wallet)));
    return `✅ Wallet created for ${walletKey}`;
}


async createWalletDirect(ctx, org, userId) {
    // Compatibility wrapper: direct mode now uses the consolidation wallet flow.
    return await this.createWallet(ctx, org, userId);
}

async createWalletNoConsolidation(ctx, org, userId) {
    // Compatibility wrapper: no-consolidation mode now uses the consolidation wallet flow.
    return await this.createWallet(ctx, org, userId);
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

  const walletKey = `${org}-${userId}-wallet`;
  const walletBytes = await ctx.stub.getState(walletKey);
  if (!walletBytes || walletBytes.length === 0) {
    throw new Error(`Wallet not found for ${org}-${userId}`);
  }

  const wallet = JSON.parse(walletBytes.toString());
  const currentCount = wallet.consolidationCount || 0;
  const objectType = `walletTx_${currentCount}`;
  const key = ctx.stub.createCompositeKey(objectType, [org, userId, txId]);
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
  return JSON.stringify({
    ok: true,
    txId,
    walletId: wid,
    amount: amt,
    balanceComputed: false,
    ts
  });
}

async depositMoneyDirect(ctx, org, userId, amount) {
  return await this.depositMoney(ctx, org, userId, amount);
}

async getWalletBalanceDirect(ctx, org, userId) {
  return await this.getWalletBalance(ctx, org, userId);
}

async transferMoneyDirect(ctx, fromOrg, fromUserId, toOrg, toUserId, amount) {
  return await this.transferMoney(ctx, fromOrg, fromUserId, toOrg, toUserId, amount);
}

async depositMoneyNoConsolidation(ctx, org, userId, amount) {
  return await this.depositMoney(ctx, org, userId, amount);
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
  const walletKey = `${org}-${userId}-wallet`;
  const walletBytes = await ctx.stub.getState(walletKey);

  if (!walletBytes || walletBytes.length === 0) {
    throw new Error(`Wallet not found for ${org}-${userId}`);
  }

  const wallet = JSON.parse(walletBytes.toString());
  const baseBalance = wallet.balance || 0;
  const currentCount = wallet.consolidationCount || 0;
  const objectType = `walletTx_${currentCount}`;
  const iterator = await ctx.stub.getStateByPartialCompositeKey(objectType, [org, userId]);

  let deltaSum = 0;

  while (true) {
    const res = await iterator.next();

    if (res.value && res.value.value.toString()) {
      const tx = JSON.parse(res.value.value.toString());
      deltaSum += tx.delta;
    }

    if (res.done) break;
  }

  await iterator.close();
  return baseBalance + deltaSum;
}

async getWalletBalanceNoConsolidation(ctx, org, userId) {
  return await this.getWalletBalance(ctx, org, userId);
}

async consolidateWallet(ctx, org, userId) {
  const walletKey = `${org}-${userId}-wallet`;
  const walletBytes = await ctx.stub.getState(walletKey);

  if (!walletBytes || walletBytes.length === 0) {
    throw new Error(`Wallet not found for ${org}-${userId}`);
  }

  const wallet = JSON.parse(walletBytes.toString());
  const currentCount = wallet.consolidationCount || 0;
  const objectType = `walletTx_${currentCount}`;
  const iterator = await ctx.stub.getStateByPartialCompositeKey(objectType, [org, userId]);

  let total = wallet.balance || 0;

  while (true) {
    const res = await iterator.next();

    if (res.value && res.value.value.toString()) {
      const tx = JSON.parse(res.value.value.toString());
      total += tx.delta;
    }

    if (res.done) break;
  }

  await iterator.close();

  wallet.balance = total;
  wallet.lastUpdated = new Date().toISOString();
  wallet.consolidationCount = currentCount + 1;

  await ctx.stub.putState(walletKey, Buffer.from(JSON.stringify(wallet)));
  return `✅ Wallet consolidated: balance = ₹${total}`;
}


// public wrapper (call this from your API)
async transferMoney(ctx, fromOrg, fromUserId, toOrg, toUserId, amount) {
  // optional: access control here
  return await this._transfer(ctx, fromOrg, fromUserId, toOrg, toUserId, amount);
}

async transferMoneyNoConsolidation(ctx, fromOrg, fromUserId, toOrg, toUserId, amount) {
  return await this.transferMoney(ctx, fromOrg, fromUserId, toOrg, toUserId, amount);
}

// internal
async _transfer(ctx, fromOrg, fromUserId, toOrg, toUserId, amount) {
  const txId = ctx.stub.getTxID();
  const ts = this._simNowISO? await this._simNowISO(ctx) : new Date().toISOString();

  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error(`Invalid transfer amount: ${amount}`);

  const fromWalletKey = `${fromOrg}-${fromUserId}-wallet`;
  const toWalletKey   = `${toOrg}-${toUserId}-wallet`;

  const fromWalletBytes = await ctx.stub.getState(fromWalletKey);
  const toWalletBytes   = await ctx.stub.getState(toWalletKey);

  if (!fromWalletBytes || fromWalletBytes.length === 0) {
    throw new Error('From wallet not found');
  }

  if (!toWalletBytes || toWalletBytes.length === 0) {
    throw new Error('To wallet not found');
  }

  // const currentBalance = await this.getWalletBalance(ctx, fromOrg, fromUserId);
  // if (Number(currentBalance) < amt) {
  //   throw new Error(`Insufficient balance in ${fromOrg}-${fromUserId}-wallet. Available: ${currentBalance}, requested: ${amt}`);
  // }

  const fromWallet = JSON.parse(fromWalletBytes.toString());
  const toWallet   = JSON.parse(toWalletBytes.toString());

  const fromCount = fromWallet.consolidationCount || 0;
  const toCount   = toWallet.consolidationCount || 0;

  const fromObjectType = `walletTx_${fromCount}`;
  const toObjectType   = `walletTx_${toCount}`;

  const debitKey = ctx.stub.createCompositeKey(fromObjectType, [
    fromOrg,
    fromUserId,
    txId,
    'debit'
  ]);

  const creditKey = ctx.stub.createCompositeKey(toObjectType, [
    toOrg,
    toUserId,
    txId,
    'credit'
  ]);

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
  return JSON.stringify({
    ok: true,
    txId,
    amount: amt,
    from: { org: fromOrg, userId: fromUserId },
    to:   { org: toOrg,   userId: toUserId },
    balanceComputed: false,
    ts
  });
}

async _transferNoConsolidation(ctx, fromOrg, fromUserId, toOrg, toUserId, amount) {
  return await this._transfer(ctx, fromOrg, fromUserId, toOrg, toUserId, amount);
}



  // ===========================================================================
  // Testing Fee, Lot Submission, And Quality Assessment
  // ===========================================================================

  async setTestingFee(ctx, auctioncenterId, feeAmount) {
  this._requireOrg(ctx, 'AuctioncentersMSP');

  const id  = String(auctioncenterId || this._userId(ctx));
  const amt = Number(feeAmount);
  if (!Number.isFinite(amt) || amt < 0) throw new Error('feeAmount must be a non-negative number');

  const key = ctx.stub.createCompositeKey('testingFee', [id]);
  const rec = {
    auctioncenterId: id,
    feeAmount: amt,
    updatedAt: this._txTimeISO(ctx)
  };
  await ctx.stub.putState(key, Buffer.from(JSON.stringify(rec)));
  return JSON.stringify({ ok:true, ...rec });
}

  async getTestingFee(ctx, auctioncenterId) {
    this._logInvocation("getTestingFee", arguments, ctx);
    console.log("ðŸš€ Function `getTestingFee invoked");
    const key = ctx.stub.createCompositeKey('testingFee', [auctioncenterId]);
    const data = await ctx.stub.getState(key);
    if (!data || data.length === 0) throw new Error('Fee not set');
    return data.toString();
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

 async submitProduceDirect(ctx, lotId, farmerId, weightKg, lotDate, bags, auctioncenterId) {
    return await this.submitProduce(ctx, lotId, farmerId, weightKg, lotDate, bags, auctioncenterId);
  }

 async submitProduceNoConsolidation(ctx, lotId, farmerId, weightKg, lotDate, bags, auctioncenterId) {
    return await this.submitProduce(ctx, lotId, farmerId, weightKg, lotDate, bags, auctioncenterId);
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

// ===========================================================================
// Finance Policy, Pricing, Offers, And EGT Computation
// ===========================================================================


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

_qTablePayloadFromInput(payload, modelName = 'Fin_RL') {
  const parsed = typeof payload === 'string' ? JSON.parse(payload || '{}') : (payload || {});
  const modelPayload = parsed[modelName] && typeof parsed[modelName] === 'object'
    ? parsed[modelName]
    : parsed;

  const normalizeTable = table => {
    const out = {};
    for (const [state, actions] of Object.entries(table || {})) {
      if (!actions || typeof actions !== 'object' || Array.isArray(actions)) continue;
      const actionOut = {};
      for (const [action, value] of Object.entries(actions)) {
        const n = Number(value);
        if (Number.isFinite(n)) actionOut[String(action)] = n;
      }
      if (Object.keys(actionOut).length) out[String(state)] = actionOut;
    }
    return out;
  };

  return {
    pure_rl_q: normalizeTable(modelPayload.pure_rl_q),
    hybrid_rl_q: normalizeTable(modelPayload.hybrid_rl_q),
    borrower_premium_q: normalizeTable(modelPayload.borrower_premium_q)
  };
}

_aggregateQTables(records, tableName = 'borrower_premium_q') {
  const sums = {};
  const counts = {};

  for (const record of records) {
    const table = record?.qTables?.[tableName] || {};
    for (const [state, actions] of Object.entries(table)) {
      sums[state] = sums[state] || {};
      counts[state] = counts[state] || {};
      for (const [action, value] of Object.entries(actions || {})) {
        const n = Number(value);
        if (!Number.isFinite(n)) continue;
        sums[state][action] = (sums[state][action] || 0) + n;
        counts[state][action] = (counts[state][action] || 0) + 1;
      }
    }
  }

  const averaged = {};
  for (const [state, actions] of Object.entries(sums)) {
    averaged[state] = {};
    for (const [action, sum] of Object.entries(actions)) {
      const count = counts[state]?.[action] || 0;
      if (count > 0) averaged[state][action] = sum / count;
    }
  }
  return averaged;
}

async submitFederatedQTableUpdate(ctx, qTablesJson, finIdOrEmpty = '', modelName = 'Fin_RL') {
  this._logInvocation("submitFederatedQTableUpdate", arguments, ctx);
  this._requireOrg(ctx, 'FinanciersMSP');

  const financierId = String(finIdOrEmpty || (this._userId ? this._userId(ctx) : 'unknown')).trim();
  if (!financierId) throw new Error('financierId required');

  const qTables = this._qTablePayloadFromInput(qTablesJson, modelName || 'Fin_RL');
  const record = {
    docType: 'federatedQTableUpdate',
    modelName: String(modelName || 'Fin_RL'),
    financierId,
    qTables,
    submittedAt: await this._nowISO(ctx),
    txId: ctx.stub.getTxID()
  };

  const key = ctx.stub.createCompositeKey('fedQTableLocal', [record.modelName, financierId]);
  await ctx.stub.putState(key, Buffer.from(JSON.stringify(record)));
  await ctx.stub.setEvent('FederatedQTableSubmitted', Buffer.from(JSON.stringify({
    modelName: record.modelName,
    financierId,
    tableCounts: {
      pure_rl_q: Object.keys(qTables.pure_rl_q).length,
      hybrid_rl_q: Object.keys(qTables.hybrid_rl_q).length,
      borrower_premium_q: Object.keys(qTables.borrower_premium_q).length
    }
  })));
  return JSON.stringify({ ok: true, key, record });
}

async aggregateFinanceFederatedQTables(ctx, modelName = 'Fin_RL', tableName = 'borrower_premium_q') {
  this._logInvocation("aggregateFinanceFederatedQTables", arguments, ctx);
  this._requireOrg(ctx, 'FinanciersMSP');

  const selectedModel = String(modelName || 'Fin_RL');
  const selectedTable = String(tableName || 'borrower_premium_q');
  const allowedTables = new Set(['pure_rl_q', 'hybrid_rl_q', 'borrower_premium_q']);
  if (!allowedTables.has(selectedTable)) {
    throw new Error(`Unsupported Q-table: ${selectedTable}`);
  }

  const iter = await ctx.stub.getStateByPartialCompositeKey('fedQTableLocal', [selectedModel]);
  const rows = await this._drainIteratorKV(iter);
  const records = [];
  for (const row of rows) {
    try {
      const rec = JSON.parse(row.value);
      if (rec?.modelName === selectedModel && rec?.qTables?.[selectedTable]) records.push(rec);
    } catch {}
  }
  if (!records.length) {
    throw new Error(`No local Q-table updates found for model ${selectedModel}`);
  }

  const aggregatedTable = this._aggregateQTables(records, selectedTable);
  const globalTables = {
    pure_rl_q: {},
    hybrid_rl_q: {},
    borrower_premium_q: {}
  };
  globalTables[selectedTable] = aggregatedTable;

  const result = {
    docType: 'federatedQTableAggregate',
    modelName: selectedModel,
    tableName: selectedTable,
    participantCount: records.length,
    participantFinancierIds: records.map(r => r.financierId).sort(),
    qTables: globalTables,
    aggregatedAt: await this._nowISO(ctx),
    txId: ctx.stub.getTxID()
  };

  const key = ctx.stub.createCompositeKey('fedQTableGlobal', [selectedModel, selectedTable]);
  await ctx.stub.putState(key, Buffer.from(JSON.stringify(result)));
  await ctx.stub.setEvent('FederatedQTablesAggregated', Buffer.from(JSON.stringify({
    modelName: selectedModel,
    tableName: selectedTable,
    participantCount: records.length,
    states: Object.keys(aggregatedTable).length
  })));
  return JSON.stringify({ ok: true, key, aggregate: result });
}

async getAggregatedFederatedQTable(ctx, modelName = 'Fin_RL', tableName = 'borrower_premium_q') {
  const key = ctx.stub.createCompositeKey('fedQTableGlobal', [String(modelName || 'Fin_RL'), String(tableName || 'borrower_premium_q')]);
  const b = await ctx.stub.getState(key);
  if (!b?.length) return JSON.stringify({ ok: false, key, aggregate: null });
  return JSON.stringify({ ok: true, key, aggregate: JSON.parse(b.toString()) });
}

async listFederatedQTableUpdates(ctx, modelName = 'Fin_RL') {
  this._requireOrg(ctx, 'FinanciersMSP');
  const iter = await ctx.stub.getStateByPartialCompositeKey('fedQTableLocal', [String(modelName || 'Fin_RL')]);
  const rows = await this._drainIteratorKV(iter);
  const updates = rows.map(row => {
    const rec = JSON.parse(row.value);
    return {
      key: row.key,
      modelName: rec.modelName,
      financierId: rec.financierId,
      submittedAt: rec.submittedAt,
      tableCounts: {
        pure_rl_q: Object.keys(rec.qTables?.pure_rl_q || {}).length,
        hybrid_rl_q: Object.keys(rec.qTables?.hybrid_rl_q || {}).length,
        borrower_premium_q: Object.keys(rec.qTables?.borrower_premium_q || {}).length
      }
    };
  });
  return JSON.stringify({ ok: true, modelName: String(modelName || 'Fin_RL'), updates });
}

async submitFinancierQTable(ctx, qTablesJson, finIdOrEmpty = '', modelName = 'Fin_RL') {
  return this.submitFederatedQTableUpdate(ctx, qTablesJson, finIdOrEmpty, modelName);
}

async blockchainAggregateQTables(ctx, modelName = 'Fin_RL', tableName = 'borrower_premium_q') {
  return this.aggregateFinanceFederatedQTables(ctx, modelName, tableName);
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

// ====================== FEDERATED Q-TABLE AGGREGATION ======================

_flattenNumericLeaves(value, prefix = '', out = {}) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Invalid Q-value at ${prefix || '<root>'}`);
    out[prefix || '$'] = value;
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, idx) => this._flattenNumericLeaves(item, `${prefix}/${idx}`, out));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const safeKey = String(key).replaceAll('~', '~0').replaceAll('/', '~1');
      this._flattenNumericLeaves(item, `${prefix}/${safeKey}`, out);
    }
    return out;
  }
  throw new Error(`Q-table contains non-numeric leaf at ${prefix || '<root>'}`);
}

_setPathValue(target, path, value) {
  const parts = String(path).split('/').filter(Boolean).map(p => p.replaceAll('~1', '/').replaceAll('~0', '~'));
  let cursor = target;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isLast = i === parts.length - 1;
    const nextPart = parts[i + 1];
    const asIndex = Number(part);
    const isIndex = Number.isInteger(asIndex) && String(asIndex) === part;
    if (isLast) {
      if (Array.isArray(cursor) && isIndex) cursor[asIndex] = value;
      else cursor[part] = value;
      return;
    }
    const nextIsIndex = Number.isInteger(Number(nextPart)) && String(Number(nextPart)) === nextPart;
    if (Array.isArray(cursor) && isIndex) {
      cursor[asIndex] = cursor[asIndex] || (nextIsIndex ? [] : {});
      cursor = cursor[asIndex];
    } else {
      cursor[part] = cursor[part] || (nextIsIndex ? [] : {});
      cursor = cursor[part];
    }
  }
}

_unflattenNumericLeaves(flat) {
  const root = {};
  for (const [path, value] of Object.entries(flat)) {
    if (path === '$') return value;
    this._setPathValue(root, path, value);
  }
  return root;
}

_parseQTableJson(qTableJson) {
  const qTable = JSON.parse(String(qTableJson || '{}'));
  const flat = this._flattenNumericLeaves(qTable);
  if (!Object.keys(flat).length) throw new Error('Q-table update cannot be empty');
  return { qTable, flat };
}

async submitFederatedQUpdate(ctx, roundId, qTableJson, modelVersion = '', metadataJson = '{}', finIdOrEmpty = '') {
  this._logInvocation("submitFederatedQUpdate", arguments, ctx);
  this._requireOrg(ctx, 'FinanciersMSP');

  const round = String(roundId || '').trim();
  const financierId = String(finIdOrEmpty || (this._userId ? this._userId(ctx) : 'unknown')).trim();
  if (!round) throw new Error('roundId required');
  if (!financierId) throw new Error('financierId required');

  const { qTable, flat } = this._parseQTableJson(qTableJson);
  const metadata = JSON.parse(String(metadataJson || '{}'));
  const submittedAt = await this._nowISO(ctx);
  const updateHash = crypto.createHash('sha256').update(JSON.stringify(qTable)).digest('hex');
  const update = {
    docType: 'fedQUpdate',
    roundId: round,
    financierId,
    modelVersion: String(modelVersion || metadata.modelVersion || ''),
    qTable,
    flatQTable: flat,
    updateHash,
    metadata,
    submittedAt,
    txId: ctx.stub.getTxID()
  };

  const key = ctx.stub.createCompositeKey('fedQUpdate', [round, financierId]);
  await ctx.stub.putState(key, Buffer.from(JSON.stringify(update)));
  await ctx.stub.setEvent('FederatedQUpdateSubmitted', Buffer.from(JSON.stringify({
    roundId: round,
    financierId,
    modelVersion: update.modelVersion,
    updateHash,
    submittedAt
  })));
  return JSON.stringify({ ok: true, roundId: round, financierId, updateHash, submittedAt });
}

async aggregateFederatedQTables(ctx, roundId, minUpdates = '1', modelVersion = '') {
  this._logInvocation("aggregateFederatedQTables", arguments, ctx);
  this._requireOrg(ctx, 'FinanciersMSP');

  const round = String(roundId || '').trim();
  if (!round) throw new Error('roundId required');
  const minCount = Math.max(1, Math.floor(Number(minUpdates || 1)));

  const iter = await ctx.stub.getStateByPartialCompositeKey('fedQUpdate', [round]);
  const updates = [];
  for (let r = await iter.next(); !r.done; r = await iter.next()) {
    if (r.value?.value) updates.push(JSON.parse(r.value.value.toString()));
  }
  await iter.close();
  if (updates.length < minCount) {
    throw new Error(`Not enough Q-table updates for round ${round}: ${updates.length}/${minCount}`);
  }

  const sums = {};
  const counts = {};
  for (const update of updates) {
    for (const [path, qValue] of Object.entries(update.flatQTable || {})) {
      sums[path] = (sums[path] || 0) + Number(qValue);
      counts[path] = (counts[path] || 0) + 1;
    }
  }

  const flatAverage = {};
  for (const [path, sum] of Object.entries(sums)) {
    flatAverage[path] = sum / counts[path];
  }
  const aggregatedQTable = this._unflattenNumericLeaves(flatAverage);
  const aggregatedAt = await this._nowISO(ctx);
  const aggregateHash = crypto.createHash('sha256').update(JSON.stringify(aggregatedQTable)).digest('hex');
  const aggregate = {
    docType: 'fedQAggregate',
    roundId: round,
    modelVersion: String(modelVersion || `fed-q-${round}`),
    aggregation: 'mean',
    participantCount: updates.length,
    participants: updates.map(u => u.financierId),
    qTable: aggregatedQTable,
    flatQTable: flatAverage,
    aggregateHash,
    aggregatedAt,
    txId: ctx.stub.getTxID()
  };

  const key = ctx.stub.createCompositeKey('fedQAggregate', [round]);
  await ctx.stub.putState(key, Buffer.from(JSON.stringify(aggregate)));
  await ctx.stub.setEvent('FederatedQTableAggregated', Buffer.from(JSON.stringify({
    roundId: round,
    modelVersion: aggregate.modelVersion,
    participantCount: aggregate.participantCount,
    aggregateHash,
    aggregatedAt
  })));
  return JSON.stringify({ ok: true, roundId: round, modelVersion: aggregate.modelVersion, participantCount: aggregate.participantCount, aggregateHash, qTable: aggregatedQTable });
}

async getFederatedQTable(ctx, roundId) {
  this._logInvocation("getFederatedQTable", arguments, ctx);
  this._requireOrg(ctx, 'FinanciersMSP');

  const round = String(roundId || '').trim();
  if (!round) throw new Error('roundId required');
  const key = ctx.stub.createCompositeKey('fedQAggregate', [round]);
  const bytes = await ctx.stub.getState(key);
  if (!bytes?.length) throw new Error(`No aggregated Q-table found for round ${round}`);
  return bytes.toString();
}

async listFederatedQUpdatesForRound(ctx, roundId) {
  this._logInvocation("listFederatedQUpdatesForRound", arguments, ctx);
  this._requireOrg(ctx, 'FinanciersMSP');

  const round = String(roundId || '').trim();
  if (!round) throw new Error('roundId required');
  const iter = await ctx.stub.getStateByPartialCompositeKey('fedQUpdate', [round]);
  const updates = [];
  for (let r = await iter.next(); !r.done; r = await iter.next()) {
    if (r.value?.value) {
      const update = JSON.parse(r.value.value.toString());
      updates.push({
        roundId: update.roundId,
        financierId: update.financierId,
        modelVersion: update.modelVersion,
        updateHash: update.updateHash,
        submittedAt: update.submittedAt
      });
    }
  }
  await iter.close();
  return JSON.stringify(updates);
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
  const SOLD_SET     = new Set(['PURCHASED', 'SOLD', 'OWNED_BY_RETAILER', 'AVAILABLE_FOR_CONSUMER_PURCHASE']);
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

  



// ===========================================================================
// Auction, Bidding, And Farmer Decision Workflow
// ===========================================================================

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
    a.bidRound = Number(a.bidRound || 1) + 1;
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
    bidRound: 1,
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

  const total = Number((p * Number(lot.weightKg)).toFixed(2));

  // Funding source
  const validSources = ['SELF', 'FINANCE'];
  const src = String(fundingSource || '').toUpperCase();
  if (!validSources.includes(src)) {
    throw new Error(`Invalid funding source. Must be one of: ${validSources.join(', ')}`);
  }

  // Record bid row (include MSP to avoid cross-org ID collisions)
  const ts = ledgerNow
  const auctionId = this._auctionId(lotId, a.bidRound || 1);
  const offer = {
    type: 'auctionOffer',
    auctionId,
    lotId,
    bidRound: Number(a.bidRound || 1),
    bidderId,
    bidderMSP: msp,                   // <-- NEW: store MSP
    pricePerKg: p,
    totalAmount: total,
    fundingSource: src,
    ts
  };

  // Key: auctionOffer~auctionId~MSP:user:ts (unique + current-auction scoped)
  const offerKey = ctx.stub.createCompositeKey('auctionOffer', [auctionId, `${msp}:${bidderId}:${ts}`]);
  await ctx.stub.putState(offerKey, Buffer.from(JSON.stringify(offer)));

  await ctx.stub.setEvent('BidPlaced', Buffer.from(JSON.stringify({
    auctionId,
    lotId,
    bidRound: Number(a.bidRound || 1),
    bidderId,
    bidderMSP: msp,
    pricePerKg: p,
    totalAmount: total,
    fundingSource: src,
    ts
  })));

  return `✅ Bid recorded for ${lotId}: ₹${p}/kg (total ₹${total}) [${src}]`;
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
  const auctionId = this._auctionId(lotId, a.bidRound || 1);
  a.highestBid = await this._getBestOfferForAuction(ctx, auctionId);

  if (!a.highestBid) {
    await ctx.stub.putState(aKey, Buffer.from(JSON.stringify(a)));
    await ctx.stub.setEvent(
      'AuctionClosed',
      Buffer.from(JSON.stringify({ lotId, result: 'NO_BIDS', closedBy: userId }))
    );
    return `✅ Auction closed by ${userId}. No bids for ${lotId}`;
  }

  if (a.reservePricePerKg != null && Number(a.highestBid.pricePerKg) < Number(a.reservePricePerKg)) {
    a.highestBid = null;
    await ctx.stub.putState(aKey, Buffer.from(JSON.stringify(a)));
    await ctx.stub.setEvent(
      'AuctionClosed',
      Buffer.from(JSON.stringify({ lotId, result: 'RESERVE_NOT_MET', closedBy: userId }))
    );
    return `✅ Auction closed by ${userId}. Reserve not met for ${lotId}`;
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
    const highestBid = auction.highestBid || {};
    const bidderId = String(highestBid.bidderId || '');
    const fundingSource = String(highestBid.fundingSource || 'SELF').toUpperCase();

    if (fundingSource === 'SELF') {
      const amount = Number(highestBid.totalAmount);
      if (!bidderId) throw new Error('Winning bidder not found for self-funded settlement');
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error(`Invalid self-funded winning amount: ${highestBid.totalAmount}`);
      }

      await this._transfer(ctx, 'wholesalers', bidderId, 'farmers', callerId, String(amount));

      lot.status = 'SOLD';
      lot.acceptedByFarmerAt = nowIso;
      lot.paidBy = bidderId;
      lot.paidAt = nowIso;
      lot.ownerId = bidderId;
      lot.wholesalerId = bidderId;

      auction.paid = true;
      auction.paidTx = ctx.stub.getTxID();
      auction.paidAt = nowIso;

      const payment = {
        docType: 'payment',
        lotId: String(lotId),
        amount: Number(amount.toFixed(2)),
        source: 'WALLET',
        financierId: null,
        from: `wholesalers.${bidderId}`,
        to: `farmers.${callerId}`,
        bidderId,
        farmerId: callerId,
        txId: ctx.stub.getTxID(),
        at: nowIso,
        status: 'SUCCESS'
      };
      const payKey = ctx.stub.createCompositeKey('payment', [String(lotId), bidderId]);
      await ctx.stub.putState(payKey, Buffer.from(JSON.stringify(payment)));
      await ctx.stub.setEvent('PaymentToFarmer', Buffer.from(JSON.stringify(payment)));
    } else {
      lot.status = 'BID-ACCEPTED';
      lot.acceptedByFarmerAt = nowIso;
      // keep auction CLOSED; winner stands until financier review
    }
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



// ===========================================================================
// Finance Request Review, Approval, And Settlement
// ===========================================================================

async createFinanceRequestForLot(ctx, lotId, financierId, tenorDaysRequested) {
  this._logInvocation("createFinanceRequestForLot", arguments, ctx);
  this._requireOrg(ctx, 'WholesalersMSP');

  if (!lotId) throw new Error('lotId required');
  if (!financierId) throw new Error('financierId required');

  const requesterId = this._userId ? this._userId(ctx) : 'unknown';

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

  const reqId = ctx.stub.getTxID();
  const policy = await this._getFinancePolicyFor(ctx, financierId, 'false');
  const maxTenorDays = Number(policy?.tenorDays ?? 0);
  const feePct = Number(policy?.feePct ?? 0);
  const penaltyPct = Number(policy?.penaltyPct ?? 0);

  let tenorDays = maxTenorDays > 0 ? maxTenorDays : 30;
  if (tenorDaysRequested !== undefined && tenorDaysRequested !== null && String(tenorDaysRequested).trim() !== '') {
    const t = Number(tenorDaysRequested);
    if (!Number.isFinite(t) || t <= 0) throw new Error('tenorDaysRequested must be a positive number');
    tenorDays = maxTenorDays > 0 ? Math.min(t, maxTenorDays) : t;
  }
  if (!Number.isFinite(tenorDays) || tenorDays <= 0) {
    throw new Error('A valid tenorDays is required to create the finance request');
  }

  const createdIso = this._simNowISO ? await this._simNowISO(ctx) : new Date().toISOString();
  const dueIso = new Date(Date.parse(createdIso) + tenorDays * 86400000).toISOString();

  const reqKey = ctx.stub.createCompositeKey('financeReq', [String(lotId), String(requesterId)]);
  const prev = await ctx.stub.getState(reqKey);
  if (prev?.length) {
    const p = JSON.parse(prev.toString());
    if (p.status !== 'REJECTED') {
      throw new Error(`A finance request already exists for lot ${lotId} by ${requesterId} (status=${p.status})`);
    }
  }

  const request = {
    docType: 'financeRequest',
    requestId: reqId,
    lotId,
    financierId,
    requesterId,
    requesterOrg: 'WholesalersMSP',
    principalAmount: Number(principal.toFixed(2)),
    outstanding: Number(principal.toFixed(2)),
    repaidAmt: 0,
    wholesalePaid: 0,
    penaltyAccum: 0,
    overdue: 0,
    payments: [],
    pricing: {
      feePct,
      annualInterestPct: 0,
      aprEnteredByFinancier: false,
      penaltyPct,
      tenorDays,
      snapshotTs: createdIso
    },
    computed: {
      feeAmt: 0,
      interestAmt: 0,
      totalPayable: Number(principal.toFixed(2))
    },
    status: 'PENDING',
    createdAt: createdIso,
    dueAt: dueIso,
    termsSnapshot: {
      source: 'FINANCIER_REVIEW_PENDING',
      score: null,
      maxTenorDays: maxTenorDays > 0 ? maxTenorDays : null
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
    feePct,
    aprPct: null,
    penaltyPct,
    source: 'FINANCIER_REVIEW_PENDING'
  })));

  return `Finance request ${request.requestId} created for lot ${lotId} -> principal ₹${request.principalAmount}, tenor ${tenorDays}d`;
}

async reviewFinanceRequest(ctx, requestId, approve, aprPctInput ) {
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
  delete req.reviewerNote;

  await ctx.stub.putState(key, Buffer.from(JSON.stringify(req)));
  await ctx.stub.setEvent('FinanceRequestReviewed', Buffer.from(JSON.stringify({ requestId: req.requestId, status: req.status })));
  if (decision) {
    return this._disburseApprovedFinanceForLot(ctx, req.lotId, req.requesterId, req);
  }
  return `✅ Request ${req.requestId} ${req.status}`;
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

async _disburseApprovedFinanceForLot(ctx, lotId, bidderId, finReq) {
  const txId = ctx.stub.getTxID();
  const nowIso = await this._simNowISO(ctx);

  const lotKey = ctx.stub.createCompositeKey('lot', [String(lotId)]);
  const lotBytes = await ctx.stub.getState(lotKey);
  if (!lotBytes?.length) throw new Error('Lot not found');
  const lot = JSON.parse(lotBytes.toString());

  const aKey = ctx.stub.createCompositeKey('auction', [String(lotId)]);
  const aBytes = await ctx.stub.getState(aKey);
  if (!aBytes?.length) throw new Error('Auction not found for this lot');
  const auction = JSON.parse(aBytes.toString());

  if (lot.status !== 'BID-ACCEPTED') {
    throw new Error(`Lot must be 'BID-ACCEPTED' (current: ${lot.status})`);
  }
  if (auction.status !== 'CLOSED') {
    throw new Error(`Auction must be 'CLOSED' (current: ${auction.status})`);
  }
  if (!auction.highestBid) throw new Error('No highest bid recorded');
  if (String(auction.highestBid.bidderId || '') !== String(bidderId)) {
    throw new Error(`Finance request bidder ${bidderId} does not match auction winner ${auction.highestBid.bidderId}`);
  }

  const farmerId = lot.farmerId || lot.ownerId || lot.submitterId;
  if (!farmerId) throw new Error('Cannot determine farmerId for this lot');

  const payKey = ctx.stub.createCompositeKey('payment', [String(lotId), String(bidderId)]);
  const prev = await ctx.stub.getState(payKey);
  if (prev?.length) {
    const doc = JSON.parse(prev.toString());
    if (doc.status === 'SUCCESS') return JSON.stringify({ info: 'already-paid', ...doc });
  }

  const reqKey = ctx.stub.createCompositeKey('financeReq', [String(lotId), String(bidderId)]);
  const reqBytes = await ctx.stub.getState(reqKey);
  const financeReq = finReq || (reqBytes?.length ? JSON.parse(reqBytes.toString()) : null);
  if (!financeReq) throw new Error(`Finance request not found for lot ${lotId}`);
  if (String(financeReq.status).toUpperCase() !== 'APPROVED') {
    throw new Error(`Finance request for lot ${lotId} is not APPROVED (current: ${financeReq.status})`);
  }

  let principal = Number(financeReq?.principalAmount);
  const feePct = Number(financeReq?.pricing?.feePct);
  const aprPct = Number(financeReq?.pricing?.annualInterestPct);
  const tenorDays = Number(financeReq?.pricing?.tenorDays);
  const computed = financeReq?.computed || {};

  if (!Number.isFinite(principal) || principal <= 0) {
    principal = Number(auction.highestBid.totalAmount || 0);
  }
  if (!Number.isFinite(principal) || principal <= 0) {
    throw new Error(`Invalid principal for financed disbursement on lot ${lotId}`);
  }

  let feeAmt = Number(computed.feeAmt);
  let interestAmt = Number(computed.interestAmt);
  let totalPayable = Number(computed.totalPayable);

  if (!Number.isFinite(feeAmt) && Number.isFinite(feePct)) {
    feeAmt = (feePct / 100) * principal;
  }
  if (!Number.isFinite(interestAmt) && Number.isFinite(aprPct) && Number.isFinite(tenorDays)) {
    interestAmt = principal * (aprPct / 100) * (tenorDays / 365);
  }
  if (!Number.isFinite(totalPayable)) {
    totalPayable = principal + (Number.isFinite(interestAmt) ? interestAmt : 0) + (Number.isFinite(feeAmt) ? feeAmt : 0);
  }

  const r2 = (v) => Number(Number(v).toFixed(2));
  principal = r2(principal);
  feeAmt = r2(feeAmt || 0);
  interestAmt = r2(interestAmt || 0);
  totalPayable = r2(totalPayable);

  const financierId = String(financeReq.financierId || '').trim();
  if (!financierId) throw new Error('Finance request missing financierId');
  if (!Number.isFinite(tenorDays) || tenorDays <= 0) throw new Error('Finance request missing tenorDays');

  const netToFarmer = r2(principal - feeAmt);
  if (!Number.isFinite(netToFarmer) || netToFarmer <= 0) {
    throw new Error(`Computed net disbursement is invalid: principal=${principal}, fee=${feeAmt}`);
  }

  await this._transfer(ctx, 'financiers', financierId, 'farmers', farmerId, String(netToFarmer));

  const dueAtIso = new Date(Date.parse(nowIso) + Number(tenorDays) * 86400000).toISOString();

  financeReq.status = 'DISBURSED';
  financeReq.disbursedAt = nowIso;
  financeReq.disbursedTx = txId;
  financeReq.dueAt = dueAtIso;
  financeReq.egtDecided = false;
  financeReq.disbursement = {
    principal,
    feeDeducted: feeAmt,
    netToFarmer
  };
  financeReq.outstanding = totalPayable;
  await ctx.stub.putState(reqKey, Buffer.from(JSON.stringify(financeReq)));

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
    amount: netToFarmer,
    source: 'FINANCE',
    financierId,
    from: `financiers.${financierId}`,
    to: `farmers.${farmerId}`,
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
      outstandingAfterDisbursement: r2(totalPayable),
      tenorDays,
      dueAt: dueAtIso
    }
  };
  await ctx.stub.putState(payKey, Buffer.from(JSON.stringify(payment)));
  await ctx.stub.setEvent('PaymentToFarmer', Buffer.from(JSON.stringify(payment)));
  return JSON.stringify(payment);
}


// ====================== PACKING ======================

// ===========================================================================
// Post-Sale Packing And Packet Commerce
// ===========================================================================

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
        retailPrice: parseFloat(prices[sizeKey]),
        salePrice: parseFloat(prices[sizeKey]),
        qrCode: packetId,
        lotRef: lotId,
        status: 'AVAILABLE_FOR_PURCHASE',
        packedAt: now,
        priceSetAt: now,
        priceSource: 'PACK_TIME',
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
          packingVideoHash,
          offeredDirectlyByWholesaler: true
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
  lot.packetPricing = {
    prices,
    source: 'PACK_TIME',
    setAt: now
  };

  putOps.push(ctx.stub.putState(lotKey, Buffer.from(JSON.stringify(lot))));
  await Promise.all(putOps);

  return `✅ Packed ${lotId} into ${counter - 1} packets. Remainder: ${remainder} g.`;
}

/**
 * Set the wholesaler price for all wholesaler-owned packets with a given weight (e.g., "500g").
 */
/**
 * After pricing, packets remain wholesaler-owned and available for retailer bulk purchase.
 */
async setPacketPriceForWeight(ctx, weightStr, price) {
  this._requireOrg(ctx, 'WholesalersMSP');
  const wholesalerId = this._clientId(ctx);

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
      const owner = this._getPacketOwner(packet);
      if (owner?.org === 'wholesalers' &&
          String(owner?.id) === wholesalerId &&
          String(packet.weight).trim() === targetWeight &&
          cur === 'AVAILABLE_FOR_PURCHASE'){

          packet.wholesalePrice = p;
          if (!Number.isFinite(Number(packet.retailPrice)) || Number(packet.retailPrice) <= 0) {
            packet.retailPrice = p;
          }
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
    wholesalerId,
    weight: targetWeight,
    wholesalePrice: p,
    updated,
    fromStatus: 'AVAILABLE_FOR_PURCHASE',
    newStatus: 'AVAILABLE_FOR_PURCHASE'
  };
  await ctx.stub.setEvent('PacketPricesUpdated', Buffer.from(JSON.stringify(payload)));
  return JSON.stringify(payload);
}

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
    let res = await iter.next();
    while (!res.done) {
      const { key, value } = res.value || {};
      if (value && value.length) {
        const packet = JSON.parse(value.toString());
        const owner = this._getPacketOwner(packet);
        const cur = String(packet.status || '').toUpperCase();
        if (owner?.org === 'retailers' &&
            String(owner?.id) === retailerId &&
            String(packet.weight).trim() === targetWeight &&
            ['AVAILABLE_FOR_CONSUMER_PURCHASE', 'OWNED_BY_RETAILER'].includes(cur)) {
          packet.retailPrice = p;
          packet.salePrice = p;
          packet.status = 'AVAILABLE_FOR_CONSUMER_PURCHASE';
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
    event: 'RetailerPricesUpdated',
    retailerId,
    weight: targetWeight,
    retailPrice: p,
    updated,
    newStatus: 'AVAILABLE_FOR_CONSUMER_PURCHASE'
  };
  await ctx.stub.setEvent('RetailerPricesUpdated', Buffer.from(JSON.stringify(payload)));
  return JSON.stringify(payload);
}




// ====================== PURCHASE======================




// Replace your existing purchasePacket with this version
// ====================== PURCHASE PACKET ======================

async purchasePacket(ctx, packetId, consumerId) {
  this._logInvocation("purchasePacket", arguments, ctx);
  this._requireOrg(ctx, 'ConsumersMSP');

  const nowIso = await this._simNowISO(ctx);

  // ------- load packet -------
  const packetKey = ctx.stub.createCompositeKey('packet', [String(packetId)]);
  const packetBytes = await ctx.stub.getState(packetKey);
  if (!packetBytes?.length) throw new Error(`Packet ${packetId} not found`);
  const packet = JSON.parse(packetBytes.toString());

  // must be held by a retailer and listed for consumer purchase
  const statusNow = String(packet.status || '').toUpperCase();
  if (!['AVAILABLE_FOR_CONSUMER_PURCHASE', 'OWNED_BY_RETAILER'].includes(statusNow)) {
    throw new Error(`Packet ${packetId} is not AVAILABLE_FOR_CONSUMER_PURCHASE (current: ${packet.status})`);
  }

  // owner must be a retailer for consumer purchase
  const owner = this._getPacketOwner ? this._getPacketOwner(packet) : { org: 'retailers', id: packet.owner };
  if (String(owner.org).toLowerCase() !== 'retailers') {
    throw new Error(`Packet ${packetId} is not owned by a retailer (ownerOrg=${owner.org})`);
  }
  const retailerId = owner.id;

  // ------- prices -------
  const consumerPrice = Number(packet.retailPrice ?? packet.salePrice ?? packet.wholesalePrice);
  if (!Number.isFinite(consumerPrice) || consumerPrice <= 0) {
    throw new Error(`Invalid packet retail price: ${packet.retailPrice ?? packet.salePrice ?? packet.wholesalePrice}`);
  }
  const wholesalePaid = 0;

  // ------- lot reference for traceability -------
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

  // Finance repayment occurs earlier when retailer buys from wholesaler via bulkPurchasePacket().
  const financeRepay = 0;

  // ==============================
  // 4) Flip ownership & trace
  // ==============================
  if (this._setPacketOwner) this._setPacketOwner(packet, 'consumers', consumerId);
  else packet.owner = consumerId;

  packet.status = 'PURCHASED';
  packet.soldAt = nowIso;
  packet.consumerId = String(consumerId);
  packet.retailerId = String(retailerId);
  packet.trace = packet.trace || {};
  packet.trace.consumerId = String(consumerId);
  packet.trace.purchasedBy = consumerId;
  packet.trace.purchasedAt = nowIso;
  packet.trace.consumerPurchase = {
    retailerId: retailerId || null,
    consumerPrice
  };
  packet.trace.settlement = {
    wholesalerId: wholesalerId || null,
    retailerId: retailerId || null,
    financeRepay,
    wholesalePaid,
    consumerPrice
  };

  await ctx.stub.putState(packetKey, Buffer.from(JSON.stringify(packet)));

  // sale event
  await ctx.stub.setEvent('PacketSold', Buffer.from(JSON.stringify({
    packetId,
    consumerId,
    lotId,
    retailerId,
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


// Retailer buys one or more packets from the wholesaler in one transaction.
// Args:
//   packetIdsJsonOrCsv: '["PACK-1","PACK-2",...]' OR 'PACK-1,PACK-2,...'
//   retailerId:         'Retailer1'
// Returns: JSON { ok, total, successes:[...], failures:[...], at }
// Atomic bulk purchase with correct finance repayment accumulation
// packetIdsJsonOrCsv: '["P1","P2"]' or 'P1,P2'
// retailerId: 'Retailer1'
// helper: incremental overdue accruals since last update


async bulkPurchasePacket(ctx, packetIdsJsonOrCsv, retailerId) {
  this._logInvocation("bulkPurchasePacket", arguments, ctx);
  this._requireOrg(ctx, 'RetailersMSP');


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
  let totalPaidByRetailer = 0;

  for (const packetId of ids) {
    const packetKey = ctx.stub.createCompositeKey('packet', [String(packetId)]);
    const packet    = JSON.parse((await ctx.stub.getState(packetKey)).toString());

    // --- Wholesaler owner ---
    const owner = this._getPacketOwner ? this._getPacketOwner(packet) : { org: 'wholesalers', id: packet.owner };
    if (String(owner.org).toLowerCase() !== 'wholesalers') {
      throw new Error(`Packet ${packetId} is not owned by a wholesaler (ownerOrg=${owner.org})`);
    }
    const wholesalerOwnerId = owner.id;

    // --- Wholesale price paid by retailer ---
    const wholesalePrice = Number(packet.wholesalePrice);
    if (!Number.isFinite(wholesalePrice) || wholesalePrice <= 0) {
      throw new Error(`Invalid packet wholesale price: ${packet.wholesalePrice}`);
    }

    // --- Lot/wholesaler (for finance linkage) ---
    const lotId = String(packet.lotRef || packet.lotId || '').trim();
    let wholesalerId = null;
    if (lotId) {
      const lotKey = ctx.stub.createCompositeKey('lot', [lotId]);
      const lotB   = await ctx.stub.getState(lotKey);
      if (lotB?.length) {
        const lot = JSON.parse(lotB.toString());
        wholesalerId = lot.ownerId || lot.acceptedOffer?.wholesalerId || wholesalerOwnerId || null;
      }
    }
    if (!wholesalerId) wholesalerId = wholesalerOwnerId;

  // 1) Retailer -> Wholesaler
    await this._transfer(ctx, 'retailers', `${retailerId}`, 'wholesalers', `${wholesalerId}`, wholesalePrice);

  // wholesale proceeds available for financier sweep
    let wholesalePaid = wholesalePrice;


  

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
              source: 'BULK_PURCHASE_PACKET',
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
        const scheduledInterest = Number(entry.fr.computed?.interestAmt || 0);
        const scheduledFee = Number(entry.fr.computed?.feeAmt || 0);
        const accruedPenaltyTotal = Number(entry.fr.penaltyAccum || 0);
        const realizedFinanceValue = repaid + scheduledInterest + scheduledFee + accruedPenaltyTotal;

        const pct = (num, den) => (den > 0 ? num / den : 0);
        entry.fr.wholesalerprofitpercent = pct(entry.fr.wholesalePaid - entry.fr.outstanding, principal);
        entry.fr.financierprofitpercent  = pct((realizedFinanceValue - principal - entry.fr.outstanding), principal);

        entry.fr.updatedAt = nowIso;
      }
    }

    // 4) Flip ownership & trace
    this._setPacketOwner ? this._setPacketOwner(packet, 'retailers', retailerId) : (packet.owner = retailerId);
    packet.status = 'AVAILABLE_FOR_CONSUMER_PURCHASE';
    packet.retailerId = String(retailerId);
    packet.retailerPurchasedAt = nowIso;
    packet.boughtByRetailerAt = nowIso;
    packet.trace = packet.trace || {};
    packet.trace.retailerId = String(retailerId);
    packet.trace.retailerPurchasedAt = nowIso;
    packet.trace.settlement = {
      wholesalerId: wholesalerId || null,
      retailerId: String(retailerId),
      financeRepay,
      wholesalePaid
    };
    await ctx.stub.putState(packetKey, Buffer.from(JSON.stringify(packet)));

    totalPaidByRetailer += wholesalePrice;
    successes.push({ packetId, financeRepay, wholesalePrice });
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

  await ctx.stub.setEvent('BulkPurchasePacket', Buffer.from(JSON.stringify({
    retailerId: String(retailerId),
    count: successes.length,
    packetIds: ids,
    totalPaidByRetailer,
    at: nowIso
  })));

  return JSON.stringify({
    ok: true,
    total: { packets: successes.length, paidByRetailer: totalPaidByRetailer },
    successes,
    failures
  });
}

async purchasePacketsBulk(ctx, packetIdsJsonOrCsv, retailerId) {
  return this.bulkPurchasePacket(ctx, packetIdsJsonOrCsv, retailerId);
}

async bulkPurchasePackets(ctx, packetIdsJsonOrCsv, retailerId) {
  return this.bulkPurchasePacket(ctx, packetIdsJsonOrCsv, retailerId);
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
  const SOLD_SET     = new Set(['PURCHASED','SOLD','OWNED_BY_RETAILER','AVAILABLE_FOR_CONSUMER_PURCHASE']);
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



// ===========================================================================
// Reporting, Query, And Pagination APIs
// ===========================================================================
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









  
_isPositiveIntegerString(value) {
  return /^\d+$/.test(String(value || '').trim());
}

_isLikelyStatus(value) {
  const status = String(value || '').trim().toUpperCase();
  if (!status) return false;

  const knownStatuses = new Set([
    'SUBMITTED',
    'APPROVED',
    'REJECTED',
    'OPEN',
    'CLOSED',
    'BID',
    'BID-ACCEPTED',
    'BID-REJECTED',
    'SOLD',
    'PACKED',
    'AVAILABLE_FOR_PURCHASE',
    'PURCHASE_REQUESTED',
    'PURCHASE_APPROVED',
    'PURCHASED',
    'PENDING',
    'DISBURSED',
    'SETTLED',
    'SUCCESS',
    'FAILED'
  ]);

  return knownStatuses.has(status);
}

_normalizeOptionalLimit(limitStr) {
  if (!String(limitStr || '').trim()) return Number.MAX_SAFE_INTEGER;
  const parsed = parseInt(limitStr, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid limit: ${limitStr}`);
  }
  return parsed;
}

_parseStatusLimitUser(arg1 = '', arg2 = '', arg3 = '') {
  const values = [arg1, arg2, arg3]
    .map(value => String(value || '').trim())
    .filter(Boolean);

  let status = '';
  let limitStr = '';
  let userId = '';

  for (const value of values) {
    if (!limitStr && this._isPositiveIntegerString(value)) {
      limitStr = value;
      continue;
    }

    if (!status && this._isLikelyStatus(value)) {
      status = value.toUpperCase();
      continue;
    }

    if (!userId) {
      userId = value;
      continue;
    }

    if (!status) {
      status = value.toUpperCase();
    }
  }

  return {
    status,
    userId,
    limit: this._normalizeOptionalLimit(limitStr)
  };
}

_lotMatchesUser(lot, userId) {
  const user = String(userId || '').trim();
  if (!user) return true;

  const candidates = [
    lot?.ownerId,
    lot?.owner,
    lot?.farmerId,
    lot?.auctioncenterId,
    lot?.aggregatorId,
    lot?.wholesalerId,
    lot?.consumerId,
    lot?.acceptedOffer?.wholesalerId,
    lot?.acceptedOffer?.bidderId
  ]
    .filter(value => value !== undefined && value !== null)
    .map(value => String(value));

  return candidates.includes(user);
}

_packetMatchesUser(packet, userId) {
  const user = String(userId || '').trim();
  if (!user) return true;

  const owner = this._getPacketOwner(packet);
  const candidates = [
    owner?.id,
    packet?.owner,
    packet?.ownerId,
    packet?.consumerId,
    packet?.requestedBy,
    packet?.trace?.farmerId,
    packet?.trace?.aggregatorId,
    packet?.trace?.auctioncenterId,
    packet?.trace?.wholesalerId,
    packet?.trace?.wholsesalerId,
    packet?.trace?.consumerId
  ]
    .filter(value => value !== undefined && value !== null)
    .map(value => String(value));

  return candidates.includes(user);
}

// Filtered getAllProduce
async getAllProduce(ctx, status = '', limit = '', userId = '') {
    this._logInvocation("getAllProduce", arguments, ctx);
    const filters = this._parseStatusLimitUser(status, limit, userId);
    console.log(`getAllProduce filters => status=${filters.status || 'ANY'}, limit=${filters.limit}, user=${filters.userId || 'ANY'}`);
    console.log(`🚀 Function getAllProduce invoked with status: ${status}`);

    const iterator = await ctx.stub.getStateByPartialCompositeKey('lot', []);
    const results = [];

    while (true) {
        const res = await iterator.next();
        if (res.value && res.value.value.toString()) {
            const lot = JSON.parse(res.value.value.toString('utf8'));
            const lotStatus = String(lot.status || '').toUpperCase();
            if (filters.status && lotStatus !== filters.status) {
                if (res.done) break;
                continue;
            }
            if (!this._lotMatchesUser(lot, filters.userId)) {
                if (res.done) break;
                continue;
            }
            results.push(lot);
            if (results.length >= filters.limit) {
                break;
            }
        }
        if (res.done) break;
    }

    await iterator.close();
    return JSON.stringify(results);
}

async getProduceByOwner(ctx, ownerId = '', limitStr = '') {
  this._logInvocation("getProduceByOwner", arguments, ctx);
  const userId = String(ownerId || '').trim();
  const limit = this._normalizeOptionalLimit(limitStr);

  const iterator = await ctx.stub.getStateByPartialCompositeKey('lot', []);
  const results = [];

  while (true) {
    const res = await iterator.next();
    if (res.value && res.value.value.toString()) {
      const lot = JSON.parse(res.value.value.toString('utf8'));
      if (!this._lotMatchesUser(lot, userId)) {
        if (res.done) break;
        continue;
      }
      results.push(lot);
      if (results.length >= limit) {
        break;
      }
    }
    if (res.done) break;
  }

  await iterator.close();
  return JSON.stringify(results);
}

async getProduceByAuctioncenter(ctx, status = '', auctioncenterId = '', limitStr = '') {
  this._logInvocation("getProduceByAuctioncenter", arguments, ctx);
  const targetStatus = String(status || '').trim().toUpperCase();
  const targetId = String(auctioncenterId || '').trim();
  const limit = this._normalizeOptionalLimit(limitStr);

  const iterator = await ctx.stub.getStateByPartialCompositeKey('lot', []);
  const results = [];

  while (true) {
    const res = await iterator.next();
    if (res.value && res.value.value.toString()) {
      const lot = JSON.parse(res.value.value.toString('utf8'));
      const matchesStatus = !targetStatus || String(lot.status || '').toUpperCase() === targetStatus;
      const matchesAuctioncenter = !targetId || String(lot.auctioncenterId || lot.aggregatorId || '') === targetId;
      if (!matchesStatus || !matchesAuctioncenter) {
        if (res.done) break;
        continue;
      }
      results.push(lot);
      if (results.length >= limit) {
        break;
      }
    }
    if (res.done) break;
  }

  await iterator.close();
  return JSON.stringify(results);
}

async getSubmittedProduceByAuctioncenter(ctx, auctioncenterId = '', limitStr = '') {
  return this.getProduceByAuctioncenter(ctx, 'SUBMITTED', auctioncenterId, limitStr);
}

async getSubmittedProduceByAggregator(ctx, aggregatorId = '', limitStr = '') {
  return this.getSubmittedProduceByAuctioncenter(ctx, aggregatorId, limitStr);
}

async getApprovedProduceByAuctioncenter(ctx, auctioncenterId = '', limitStr = '') {
  return this.getProduceByAuctioncenter(ctx, 'APPROVED', auctioncenterId, limitStr);
}

async getAcceptedLotsByWholesaler(ctx, wholesalerId = '', limitStr = '') {
  this._logInvocation("getAcceptedLotsByWholesaler", arguments, ctx);
  const targetId = String(wholesalerId || '').trim() || (this._userId ? this._userId(ctx) : '');
  const limit = this._normalizeOptionalLimit(limitStr);

  if (!targetId) {
    throw new Error('wholesalerId is required');
  }

  const iterator = await ctx.stub.getStateByPartialCompositeKey('lot', []);
  const results = [];

  while (true) {
    const res = await iterator.next();
    if (res.value && res.value.value.toString()) {
      const lot = JSON.parse(res.value.value.toString('utf8'));
      const lotStatus = String(lot.status || '').toUpperCase();
      const acceptedWholesalerId = String(
        lot?.acceptedOffer?.wholesalerId ||
        lot?.acceptedOffer?.bidderId ||
        lot?.wholesalerId ||
        ''
      );

      if (lotStatus !== 'BID-ACCEPTED' || acceptedWholesalerId !== targetId) {
        if (res.done) break;
        continue;
      }

      results.push(lot);
      if (results.length >= limit) {
        break;
      }
    }
    if (res.done) break;
  }

  await iterator.close();
  return JSON.stringify(results);
}

async getProduceByStatusAndOwner(ctx, status = '', ownerId = '', limitStr = '') {
  this._logInvocation("getProduceByStatusAndOwner", arguments, ctx);
  const targetStatus = String(status || '').trim().toUpperCase();
  const targetOwner = String(ownerId || '').trim();
  const limit = this._normalizeOptionalLimit(limitStr);

  const iterator = await ctx.stub.getStateByPartialCompositeKey('lot', []);
  const results = [];

  while (true) {
    const res = await iterator.next();
    if (res.value && res.value.value.toString()) {
      const lot = JSON.parse(res.value.value.toString('utf8'));
      const lotStatus = String(lot.status || '').toUpperCase();
      if (targetStatus && lotStatus !== targetStatus) {
        if (res.done) break;
        continue;
      }
      if (!this._lotMatchesUser(lot, targetOwner)) {
        if (res.done) break;
        continue;
      }
      results.push(lot);
      if (results.length >= limit) {
        break;
      }
    }
    if (res.done) break;
  }

  await iterator.close();
  return JSON.stringify(results);
}


async getLotsWithAuctions(ctx, status = '', userId = '') {
    this._logInvocation("getLotsWithAuctions", arguments, ctx);
    console.log(`🚀 Function getLotsWithAuctions invoked with status: ${status}, userId: ${userId || 'ANY'}`);

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
                    const matchesUser = !userId || lot?.farmerId === userId;

                    if (matchesUser) {
                        results.push({ lot, auction });
                    }
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
async getAllPackets(ctx, status = '', limit = '', userId = '') {
    this._logInvocation("getAllPackets", arguments, ctx);
    const filters = this._parseStatusLimitUser(status, limit, userId);
    console.log(`getAllPackets filters => status=${filters.status || 'ANY'}, limit=${filters.limit}, user=${filters.userId || 'ANY'}`);
    console.log(`🚀 Function getAllPackets invoked with status: ${status}`);

    const iterator = await ctx.stub.getStateByPartialCompositeKey('packet', []);
    const packets = [];

    while (true) {
        const res = await iterator.next();
        if (res.value && res.value.value.toString()) {
            try {
                const packet = JSON.parse(res.value.value.toString('utf8'));
                const packetStatus = String(packet.status || '').toUpperCase();
                if (filters.status && packetStatus !== filters.status) {
                    if (res.done) break;
                    continue;
                }
                if (!this._packetMatchesUser(packet, filters.userId)) {
                    if (res.done) break;
                    continue;
                }
                packets.push(packet);
                if (packets.length >= filters.limit) {
                    break;
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







_buildFinanceProjection(rec, nowIso = new Date().toISOString()) {
  const principal = Number(rec.principalAmount || 0);
  const aprPct = Number(rec.pricing?.annualInterestPct || 0);
  const feePct = Number(rec.pricing?.feePct || 0);
  const penaltyPct = Number(rec.pricing?.penaltyPct || 0);
  const tenorDaysRaw = Number(rec.pricing?.tenorDays || 0);
  const tenorDays = Number.isFinite(tenorDaysRaw) && tenorDaysRaw > 0 ? tenorDaysRaw : 0;
  const repaidAmt = Number(rec.repaidAmt || 0);
  const outstanding = Number(rec.outstanding || 0);
  const penaltyAccum = Number(rec.penaltyAccum || 0);
  const realizedInterest = Number(rec.interest || 0);

  const feeAmtStored = Number(rec.computed?.feeAmt ?? rec.feeAmt ?? NaN);
  const feeAmt = Number.isFinite(feeAmtStored)
    ? feeAmtStored
    : Number((principal * (feePct / 100)).toFixed(2));

  const scheduledInterestStored = Number(rec.computed?.interestAmt ?? rec.interestAmt ?? NaN);
  const scheduledInterest = Number.isFinite(scheduledInterestStored)
    ? scheduledInterestStored
    : Number((principal * (aprPct / 100) * ((tenorDays || 0) / 365)).toFixed(2));

  const scheduledTotalStored = Number(rec.computed?.totalPayable ?? NaN);
  const scheduledTotalPayable = Number.isFinite(scheduledTotalStored)
    ? scheduledTotalStored
    : Number((principal + feeAmt + scheduledInterest).toFixed(2));

  const status = String(rec.status || '').toUpperCase();
  const isSettled = status === 'SETTLED';
  const isProjected = !isSettled;

  const dueMs = Date.parse(rec.dueAt || '');
  const createdMs = Date.parse(rec.createdAt || '');
  const nowMs = Date.parse(nowIso || '');
  const remainingDays = Number.isFinite(dueMs) && Number.isFinite(nowMs)
    ? Math.max(0, Math.ceil((dueMs - nowMs) / 86400000))
    : 0;
  const elapsedDays = Number.isFinite(createdMs) && Number.isFinite(nowMs)
    ? Math.max(0, Math.ceil((nowMs - createdMs) / 86400000))
    : 0;

  const projectedInterest = isSettled
    ? realizedInterest
    : Math.max(realizedInterest, scheduledInterest);
  const projectedRemainingInterest = Math.max(0, projectedInterest - realizedInterest);
  const projectedPenaltyAccum = penaltyAccum;
  const projectedTotalPayable = isSettled
    ? Number((repaidAmt + realizedInterest + feeAmt + penaltyAccum).toFixed(2))
    : Number((principal + feeAmt + projectedInterest + projectedPenaltyAccum).toFixed(2));

  const actualFinancierProfit = Number((repaidAmt + realizedInterest + feeAmt + penaltyAccum - principal - outstanding).toFixed(2));
  const projectedFinancierProfit = isSettled
    ? actualFinancierProfit
    : Number((projectedTotalPayable - principal).toFixed(2));

  const projectedFinancierProfitPct = principal > 0
    ? Number((projectedFinancierProfit / principal).toFixed(4))
    : 0;

  return {
    aprPct: Number(aprPct.toFixed(2)),
    feePct: Number(feePct.toFixed(2)),
    penaltyPct: Number(penaltyPct.toFixed(2)),
    tenorDays,
    scheduledInterest: Number(scheduledInterest.toFixed(2)),
    scheduledFeeAmt: Number(feeAmt.toFixed(2)),
    scheduledTotalPayable: Number(scheduledTotalPayable.toFixed(2)),
    realizedInterest: Number(realizedInterest.toFixed(2)),
    actualFinancierProfit,
    projectedInterest: Number(projectedInterest.toFixed(2)),
    projectedRemainingInterest: Number(projectedRemainingInterest.toFixed(2)),
    projectedPenaltyAccum: Number(projectedPenaltyAccum.toFixed(2)),
    projectedTotalPayable,
    projectedFinancierProfit,
    projectedFinancierProfitPct,
    remainingDays,
    elapsedDays,
    isProjected
  };
}

// Return finance requests on the ledger.
// Optional filters:
// - financierId
// - status
// - limit
async getAllFinanceRequestDetails(ctx, financierId = '', status = '', limit = '') {
  this._logInvocation("getAllFinanceRequestDetails", arguments, ctx);

  let targetFinancierId = String(financierId || '').trim();
  if (!targetFinancierId && ctx?.clientIdentity?.getMSPID?.() === 'FinanciersMSP') {
    targetFinancierId = this._clientId(ctx);
  }
  const targetStatus = String(status || '').trim().toUpperCase();
  const maxRows = Math.max(1, parseInt(limit, 10) || Number.MAX_SAFE_INTEGER);

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
        const recFinancierId = String(rec.financierId || '').trim();
        const recStatus = String(rec.status || '').toUpperCase();

        if (targetFinancierId && recFinancierId !== targetFinancierId) {
          if (r.done) break;
          continue;
        }
        if (targetStatus && recStatus !== targetStatus) {
          if (r.done) break;
          continue;
        }

        const projection = this._buildFinanceProjection(rec, nowIso);

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
          requestId:     rec.requestId || '',
          lotId:         rec.lotId || '',
          wholesalerId:  rec.wholesalerId || rec.requesterId || '',
          requesterId:   rec.requesterId || rec.wholesalerId || '',
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
          lastUpdate:    rec.updatedAt || '',
          scheduledInterest: projection.scheduledInterest,
          scheduledFeeAmt: projection.scheduledFeeAmt,
          scheduledTotalPayable: projection.scheduledTotalPayable,
          projectedInterest: projection.projectedInterest,
          projectedRemainingInterest: projection.projectedRemainingInterest,
          projectedPenaltyAccum: projection.projectedPenaltyAccum,
          projectedTotalPayable: projection.projectedTotalPayable,
          projectedFinancierProfit: projection.projectedFinancierProfit,
          projectedFinancierProfitPct: projection.projectedFinancierProfitPct,
          actualFinancierProfit: projection.actualFinancierProfit,
          remainingDays: projection.remainingDays,
          elapsedDays: projection.elapsedDays,
          isProjected: projection.isProjected
        };

        out.push(short);
        if (out.length >= maxRows) {
          break;
        }
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

// Return loans for a single financier together with aggregated wholesaler history.
// This is useful for RL agents that need both loan-level rows and borrower context.
async getFinanceLoansByFinancier(ctx, financierId = '', status = '', limit = '') {
  this._logInvocation("getFinanceLoansByFinancier", arguments, ctx);

  const requestedFinancierId = String(financierId || '').trim();
  let targetFinancierId = requestedFinancierId;

  if (!targetFinancierId && ctx?.clientIdentity?.getMSPID?.() === 'FinanciersMSP') {
    targetFinancierId = this._clientId(ctx);
  }
  if (!targetFinancierId) {
    throw new Error('financierId required');
  }

  const targetStatus = String(status || '').trim().toUpperCase();
  const maxRows = Math.max(1, parseInt(limit, 10) || 500);

  const iterator = await ctx.stub.getStateByPartialCompositeKey('financeReq', []);
  const allRows = [];

  try {
    while (true) {
      const r = await iterator.next();
      if (r.value && r.value.value) {
        try {
          const rec = JSON.parse(r.value.value.toString('utf8'));
          const projection = this._buildFinanceProjection(rec);
          const wholesalerId = String(rec.wholesalerId || rec.requesterId || '').trim();
          const recFinancierId = String(rec.financierId || '').trim();
          const recStatus = String(rec.status || '').toUpperCase();

          allRows.push({
            financeId: rec.financeId || r.value.key,
            requestId: rec.requestId || '',
            lotId: rec.lotId || '',
            wholesalerId,
            requesterId: wholesalerId,
            financierId: recFinancierId,
            principalAmount: Number(rec.principalAmount || 0),
            outstanding: Number(rec.outstanding || 0),
            repaidAmt: Number(rec.repaidAmt || 0),
            penaltyAccum: Number(rec.penaltyAccum || 0),
            interest: Number(rec.interest || rec.computed?.interestAmt || 0),
            feeAmt: Number(rec.computed?.feeAmt || rec.feeAmt || 0),
            annualInterestPct: Number(rec.pricing?.annualInterestPct || 0),
            tenorDays: Number(rec.pricing?.tenorDays || 0),
            scheduledInterest: projection.scheduledInterest,
            scheduledFeeAmt: projection.scheduledFeeAmt,
            scheduledTotalPayable: projection.scheduledTotalPayable,
            projectedInterest: projection.projectedInterest,
            projectedRemainingInterest: projection.projectedRemainingInterest,
            projectedPenaltyAccum: projection.projectedPenaltyAccum,
            projectedTotalPayable: projection.projectedTotalPayable,
            projectedFinancierProfit: projection.projectedFinancierProfit,
            projectedFinancierProfitPct: projection.projectedFinancierProfitPct,
            actualFinancierProfit: projection.actualFinancierProfit,
            remainingDays: projection.remainingDays,
            elapsedDays: projection.elapsedDays,
            isProjected: projection.isProjected,
            overdue: Number(rec.overdue || 0),
            status: recStatus,
            soldStatus: String(rec.status_sold || '').toUpperCase(),
            settledAt: rec.settledAt || '',
            createdAt: rec.createdAt || '',
            dueAt: rec.dueAt || '',
            updatedAt: rec.updatedAt || '',
            wholesalerPaid: Number(rec.wholesalePaid || rec.paidByWholesaler || 0),
            wholesalerprofitpercent: Number(rec.wholesalerprofitpercent || 0),
            financierprofitpercent: Number(rec.financierprofitpercent || 0),
            finScore: Number(rec.finScore || 0),
            whScore: Number(rec.whScore || 0)
          });
        } catch (e) {
          console.error('❌ parse error in getFinanceLoansByFinancier:', e.message);
        }
      }
      if (r.done) break;
    }
  } finally {
    await iterator.close();
  }

  const wholesalerStats = new Map();
  for (const row of allRows) {
    const wid = String(row.wholesalerId || '').trim();
    if (!wid) continue;
    if (!wholesalerStats.has(wid)) {
      wholesalerStats.set(wid, {
        wholesalerId: wid,
        totalLoans: 0,
        pendingLoans: 0,
        approvedLoans: 0,
        disbursedLoans: 0,
        settledLoans: 0,
        rejectedLoans: 0,
        overdueLoans: 0,
        principalAmount: 0,
        outstanding: 0,
        repaidAmt: 0,
        penaltyAccum: 0,
        avgAprPct: 0,
        avgFinancierProfitPct: 0,
        avgWholesalerProfitPct: 0,
        latestFinScore: 0,
        latestWhScore: 0,
        lastLoanCreatedAt: ''
      });
    }
    const stats = wholesalerStats.get(wid);
    stats.totalLoans += 1;
    if (row.status === 'PENDING') stats.pendingLoans += 1;
    if (row.status === 'APPROVED') stats.approvedLoans += 1;
    if (row.status === 'DISBURSED') stats.disbursedLoans += 1;
    if (row.status === 'SETTLED') stats.settledLoans += 1;
    if (row.status === 'REJECTED') stats.rejectedLoans += 1;
    if (row.overdue > 0) stats.overdueLoans += 1;
    stats.principalAmount += row.principalAmount;
    stats.outstanding += row.outstanding;
    stats.repaidAmt += row.repaidAmt;
    stats.penaltyAccum += row.penaltyAccum;
    stats.avgAprPct += row.annualInterestPct;
    stats.avgFinancierProfitPct += row.financierprofitpercent;
    stats.avgWholesalerProfitPct += row.wholesalerprofitpercent;

    const createdAt = String(row.createdAt || '');
    if (createdAt && (!stats.lastLoanCreatedAt || Date.parse(createdAt) >= Date.parse(stats.lastLoanCreatedAt))) {
      stats.latestFinScore = row.finScore;
      stats.latestWhScore = row.whScore;
      stats.lastLoanCreatedAt = createdAt;
    }
  }

  for (const stats of wholesalerStats.values()) {
    const total = Math.max(1, stats.totalLoans);
    stats.avgAprPct = Number((stats.avgAprPct / total).toFixed(2));
    stats.avgFinancierProfitPct = Number((stats.avgFinancierProfitPct / total).toFixed(4));
    stats.avgWholesalerProfitPct = Number((stats.avgWholesalerProfitPct / total).toFixed(4));
    stats.principalAmount = Number(stats.principalAmount.toFixed(2));
    stats.outstanding = Number(stats.outstanding.toFixed(2));
    stats.repaidAmt = Number(stats.repaidAmt.toFixed(2));
    stats.penaltyAccum = Number(stats.penaltyAccum.toFixed(2));
  }

  const filtered = allRows
    .filter((row) => String(row.financierId) === targetFinancierId)
    .filter((row) => !targetStatus || String(row.status) === targetStatus)
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
    .slice(0, maxRows)
    .map((row) => ({
      ...row,
      wholesalerProfile: wholesalerStats.get(String(row.wholesalerId || '').trim()) || null
    }));

  return JSON.stringify({
    ok: true,
    financierId: targetFinancierId,
    status: targetStatus || '',
    count: filtered.length,
    data: filtered,
    wholesalerProfiles: [...wholesalerStats.values()]
      .filter((profile) => filtered.some((row) => String(row.wholesalerId) === String(profile.wholesalerId)))
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
    const aKey = ctx.stub.createCompositeKey('auction', [lotId]);
    const aBytes = await ctx.stub.getState(aKey);

    let highestOffer = null;
    if (aBytes?.length) {
        const auction = JSON.parse(aBytes.toString());
        highestOffer = await this._getBestOfferForAuction(ctx, this._auctionId(lotId, auction.bidRound || 1));
    }

    // ✅ No throw — return null if no offer exists
    return JSON.stringify({ highest: highestOffer });
}

async getBestOfferForAuction(ctx, auctionId) {
    console.log("🚀 Function `getBestOfferForAuction` invoked");
    const bestOffer = await this._getBestOfferForAuction(ctx, auctionId);
    return JSON.stringify({ highest: bestOffer });
}


 




}

module.exports = SupplyChainContract;
