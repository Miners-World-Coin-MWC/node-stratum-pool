var util = require('./util.js');

var generateOutputTransactions = function (poolRecipient, recipients, rpcData, network, poolOptions) {

    // ------------------------------------------------------------------
    // Consensus-safe coinbase construction (MWC)
    // ------------------------------------------------------------------

    const totalReward = rpcData.coinbasevalue !== undefined
        ? rpcData.coinbasevalue
        : util.getKotoBlockSubsidy(rpcData.height) - rpcData.coinbasetxn.fee;

    let remaining = totalReward;

    const txOutputBuffers = [];

    // -------------------------------------------------------
    // 1. SegWit witness commitment MUST be first (if present)
    // -------------------------------------------------------
    if (rpcData.default_witness_commitment !== undefined) {
        const witnessCommitment = Buffer.from(rpcData.default_witness_commitment, 'hex');
        txOutputBuffers.push(Buffer.concat([
            util.packInt64LE(0),
            util.varIntBuffer(witnessCommitment.length),
            witnessCommitment
        ]));
    }

    // -------------------------------------------------------
    // 2. Mandatory developer fee (daemon-defined, FIXED)
    // -------------------------------------------------------
    if (rpcData.developer && rpcData.developer.amount > 0) {
        const devAmt = rpcData.developer.amount;
        const devScript = Buffer.from(rpcData.developer.script, 'hex');

        txOutputBuffers.push(Buffer.concat([
            util.packInt64LE(devAmt),
            util.varIntBuffer(devScript.length),
            devScript
        ]));

        remaining -= devAmt;
    }

    // -------------------------------------------------------
    // 3. Pool payout (single deterministic output)
    // -------------------------------------------------------
    txOutputBuffers.push(Buffer.concat([
        util.packInt64LE(remaining),
        util.varIntBuffer(poolRecipient.length),
        poolRecipient
    ]));

    // -------------------------------------------------------
    // DEBUG (keep this — it’s useful)
    // -------------------------------------------------------
    console.log('[MWC COINBASE]',
        txOutputBuffers.map(b => b.toString('hex'))
    );

    // -------------------------------------------------------
    // Final serialization
    // -------------------------------------------------------
    return Buffer.concat([
        util.varIntBuffer(txOutputBuffers.length),
        Buffer.concat(txOutputBuffers)
    ]);
};

exports.CreateGeneration = function (
    rpcData,
    publicKey,
    extraNoncePlaceholder,
    reward,
    txMessages,
    recipients,
    network,
    poolOptions
) {

    var txInputsCount = 1;
    var txOutputsCount = 1; // kept for compatibility
    var txVersion;          // ✅ IMPORTANT: declare this

    if (rpcData.Modified_Coinbase_txn0 && rpcData.Modified_Coinbase_txn1) {
        txVersion = txMessages === true ? 7 : 9;
    } else {
        txVersion = txMessages === true ? 2 : 1;
    }

    if (rpcData.coinbasetxn && rpcData.coinbasetxn.data) {
        // tx version is first 4 bytes of coinbasetxn.data
        txVersion = parseInt(
            util.reverseHex(rpcData.coinbasetxn.data.slice(0, 8)),
            16
        );
    }

    var txType = 0;
    var txExtraPayload;
    var txLockTime = 0;

    if (rpcData.coinbase_payload && rpcData.coinbase_payload.length > 0) {
        txVersion = 3;
        txType = 5;
        txExtraPayload = Buffer.from(rpcData.coinbase_payload, 'hex');
    }

    if (!(rpcData.coinbasetxn && rpcData.coinbasetxn.data)) {
        txVersion = txVersion + (txType << 16);
    }

    var txInPrevOutHash = "";
    var txInPrevOutIndex = Math.pow(2, 32) - 1;
    var txInSequence = 0;

    // Only required for POS coins
    var txTimestamp = reward === 'POS'
        ? util.packUInt32LE(rpcData.curtime)
        : Buffer.from([]);

    // Transaction comment support
    var txComment = txMessages === true
        ? util.serializeString('https://github.com/zone117x/node-stratum')
        : Buffer.from([]);

    var scriptSigPart1 = Buffer.concat([
        util.serializeNumber(rpcData.height),
        util.serializeNumber(Date.now() / 1000 | 0),
        Buffer.from([extraNoncePlaceholder.length])
    ]);

    var scriptSigPart2 = util.serializeString(util.getBlockIdentifier());

    // Koto / Zcash-style version group ID
    var nVersionGroupId =
        (txVersion & 0x7fffffff) === 3 ? util.packUInt32LE(0x2e7d970) :
        (txVersion & 0x7fffffff) === 4 ? util.packUInt32LE(0x9023e50a) :
        Buffer.alloc(0);

    var p1 = Buffer.concat([
        util.packUInt32LE(txVersion),
        nVersionGroupId,
        txTimestamp,

        // Transaction input
        util.varIntBuffer(txInputsCount),
        util.uint256BufferFromHash(txInPrevOutHash),
        util.packUInt32LE(txInPrevOutIndex),
        util.varIntBuffer(
            scriptSigPart1.length +
            extraNoncePlaceholder.length +
            scriptSigPart2.length
        ),
        scriptSigPart1
    ]);

    /*
      Coinbase transaction is split at the extranonce.
      Miners fill in extranonce between p1 and p2.
    */

    var outputTransactions = generateOutputTransactions(
        publicKey,
        recipients,
        rpcData,
        network,
        poolOptions
    );

    // Koto / Zcash extensions
    var nExpiryHeight = (txVersion & 0x7fffffff) >= 3
        ? util.packUInt32LE(0)
        : Buffer.alloc(0);

    var valueBalance = (txVersion & 0x7fffffff) >= 4
        ? util.packInt64LE(0)
        : Buffer.alloc(0);

    var vShieldedSpend = (txVersion & 0x7fffffff) >= 4
        ? Buffer.from([0])
        : Buffer.alloc(0);

    var vShieldedOutput = (txVersion & 0x7fffffff) >= 4
        ? Buffer.from([0])
        : Buffer.alloc(0);

    var nJoinSplit = (txVersion & 0x7fffffff) >= 2
        ? Buffer.from([0])
        : Buffer.alloc(0);

    var p2;

    if (txExtraPayload !== undefined) {
        p2 = Buffer.concat([
            scriptSigPart2,
            util.packUInt32LE(txInSequence),

            // outputs
            outputTransactions,

            util.packUInt32LE(txLockTime),
            txComment,
            util.varIntBuffer(txExtraPayload.length),
            txExtraPayload
        ]);
    } else {
        p2 = Buffer.concat([
            scriptSigPart2,
            util.packUInt32LE(txInSequence),

            // outputs
            outputTransactions,

            util.packUInt32LE(txLockTime),
            nExpiryHeight,
            valueBalance,
            vShieldedSpend,
            vShieldedOutput,
            nJoinSplit,
            txComment
        ]);
    }

    return [p1, p2];
};
