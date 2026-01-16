var util = require('./util.js');

/**
 * Build coinbase outputs.
 * IMPORTANT:
 * - Daemon defines developer.amount → pool MUST emit it once, unchanged
 * - Pool must NOT subtract dev fee twice
 */
var generateOutputTransactions = function (poolRecipient, recipients, rpcData) {

    // IMPORTANT:
    // coinbasevalue is ALREADY miner-only for MWC
    const minerReward = rpcData.coinbasevalue;

    const txOutputBuffers = [];
    let rewardToPool = minerReward;
    let recipientTotal = 0;

    // -------------------------------------------------------
    // 1. SegWit witness commitment (FIRST)
    // -------------------------------------------------------
    if (rpcData.default_witness_commitment) {
        const wc = Buffer.from(rpcData.default_witness_commitment, 'hex');
        txOutputBuffers.push(Buffer.concat([
            util.packInt64LE(0),
            util.varIntBuffer(wc.length),
            wc
        ]));
    }

    // -------------------------------------------------------
    // 2. Developer fee (EXTRA — not part of coinbasevalue)
    // -------------------------------------------------------
    if (rpcData.developer && rpcData.developer.amount > 0) {
        const devAmt = rpcData.developer.amount;
        let devScript = null;

        if (rpcData.developer.script) {
            devScript = Buffer.from(rpcData.developer.script, 'hex');
        } else if (rpcData.developer.payee) {
            devScript = util.addressToScript(null, rpcData.developer.payee);
        }

        if (devScript) {
            txOutputBuffers.push(Buffer.concat([
                util.packInt64LE(devAmt),
                util.varIntBuffer(devScript.length),
                devScript
            ]));
        } else {
            console.warn('Developer data missing script/payee at height ' + rpcData.height);
        }
    }

    // -------------------------------------------------------
    // 3. Pool fee recipients (percent of miner reward)
    // -------------------------------------------------------
    if (Array.isArray(recipients) && recipients.length > 0) {
        for (let k = 0; k < recipients.length; k++) {
            let recipientReward;
            if (recipients[k].percent === 0) {
                if (recipients[k].value < rewardToPool) {
                    recipientReward = recipients[k].value;
                } else {
                    continue;
                }
            } else {
                recipientReward = Math.floor(recipients[k].percent * minerReward);
            }
            if (recipientReward <= 0) {
                continue;
            }
            rewardToPool -= recipientReward;
            recipientTotal += recipientReward;
            txOutputBuffers.push(Buffer.concat([
                util.packInt64LE(recipientReward),
                util.varIntBuffer(recipients[k].script.length),
                recipients[k].script
            ]));
        }
    }

    // -------------------------------------------------------
    // 4. Pool payout = miner reward minus pool fees
    // -------------------------------------------------------
    txOutputBuffers.push(Buffer.concat([
        util.packInt64LE(rewardToPool),
        util.varIntBuffer(poolRecipient.length),
        poolRecipient
    ]));

    console.log('[MWC COINBASE]',
        'miner=', minerReward,
        'fees=', recipientTotal,
        'dev=', rpcData.developer?.amount || 0,
        txOutputBuffers.map(b => b.toString('hex'))
    );

    return Buffer.concat([
        util.varIntBuffer(txOutputBuffers.length),
        Buffer.concat(txOutputBuffers)
    ]);
};

/**
 * Coinbase transaction builder
 * NOTE: No reward logic lives here — DO NOT TOUCH AMOUNTS
 */
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

    // -------------------------------------------------------
    // Transaction version selection
    // -------------------------------------------------------
    if (rpcData.Modified_Coinbase_txn0 && rpcData.Modified_Coinbase_txn1) {
        txVersion = txMessages === true ? 7 : 9;
    } else {
        txVersion = txMessages === true ? 2 : 1;
    }

    if (rpcData.coinbasetxn && rpcData.coinbasetxn.data) {
        txVersion = parseInt(
            util.reverseHex(rpcData.coinbasetxn.data.slice(0, 8)), 16
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

    // POS only
    var txTimestamp = reward === 'POS'
        ? util.packUInt32LE(rpcData.curtime)
        : Buffer.from([]);

    var txComment = txMessages === true
        ? util.serializeString('https://github.com/zone117x/node-stratum')
        : Buffer.from([]);

    var scriptSigPart1 = Buffer.concat([
        util.serializeNumber(rpcData.height),
        util.serializeNumber(Date.now() / 1000 | 0),
        Buffer.from([extraNoncePlaceholder.length])
    ]);

    var scriptSigPart2 = util.serializeString(util.getBlockIdentifier());

    // Koto v3/v4 support
    var nVersionGroupId =
        (txVersion & 0x7fffffff) == 3 ? util.packUInt32LE(0x2e7d970) :
        (txVersion & 0x7fffffff) == 4 ? util.packUInt32LE(0x9023e50a) :
        Buffer.alloc(0);

    var p1 = Buffer.concat([
        util.packUInt32LE(txVersion),
        nVersionGroupId,
        txTimestamp,

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

    // -------------------------------------------------------
    // Outputs (amounts already finalized)
    // -------------------------------------------------------
    var outputTransactions = generateOutputTransactions(
        publicKey,
        recipients,
        rpcData
    );

    // Koto extras
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

    var p2 = txExtraPayload !== undefined
        ? Buffer.concat([
            scriptSigPart2,
            util.packUInt32LE(txInSequence),
            outputTransactions,
            util.packUInt32LE(txLockTime),
            txComment,
            util.varIntBuffer(txExtraPayload.length),
            txExtraPayload
        ])
        : Buffer.concat([
            scriptSigPart2,
            util.packUInt32LE(txInSequence),
            outputTransactions,
            util.packUInt32LE(txLockTime),
            nExpiryHeight,
            valueBalance,
            vShieldedSpend,
            vShieldedOutput,
            nJoinSplit,
            txComment
        ]);

    return [p1, p2];
};
