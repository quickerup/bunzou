import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse } from '../src/frontend/parser';
import { compileProgram } from '../src/codegen';
import { crc32 } from '../src/codegen/crc32';
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Contract, ContractProvider, Sender, Address, Cell, beginCell, contractAddress, SendMode } from '@ton/core';

class BunzouCounter implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromConfig(code: Cell, owner: Address): BunzouCounter {
        const data = beginCell()
            .storeUint(0, 1) // Active tag = 0
            .storeUint(0, 64) // count = 0
            .storeAddress(owner)
            .endCell();
        const init = { code, data };
        return new BunzouCounter(contractAddress(0, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async sendIncrement(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(crc32("Increment"), 32).endCell(),
        });
    }

    async sendReset(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(crc32("Reset"), 32).endCell(),
        });
    }

    async sendLock(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(crc32("Lock"), 32).endCell(),
        });
    }

    async sendUnlock(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(crc32("Unlock"), 32).endCell(),
        });
    }

    async getGetCount(provider: ContractProvider) {
        const result = await provider.get('get_count', []);
        return result.stack.readBigNumber();
    }
}

test('executes counter contract in sandbox', async () => {
    const fixturePath = path.join(process.cwd(), 'test', 'fixtures', 'counter.bunzou');
    const source = fs.readFileSync(fixturePath, 'utf-8');
    const program = parse(source);
    const result = await compileProgram(program);
    const codeCell = Cell.fromBoc(result.boc)[0];

    const blockchain = await Blockchain.create();
    const deployer = await blockchain.treasury('deployer');
    const attacker = await blockchain.treasury('attacker');

    const counter = blockchain.openContract(BunzouCounter.createFromConfig(codeCell, deployer.address));

    // Deploy
    const deployResult = await counter.sendDeploy(deployer.getSender(), 10000000n);
    assert.equal(deployResult.transactions.length > 0, true);

    // Initial count should be 0
    let count = await counter.getGetCount();
    assert.equal(count, 0n);

    // Increment
    await counter.sendIncrement(deployer.getSender(), 10000000n);
    count = await counter.getGetCount();
    assert.equal(count, 1n);

    // Increment again
    await counter.sendIncrement(attacker.getSender(), 10000000n); // Anyone can increment
    count = await counter.getGetCount();
    assert.equal(count, 2n);

    // Reset from non-owner should throw exit code 400
    const failedReset = await counter.sendReset(attacker.getSender(), 10000000n);
    assert.equal(failedReset.transactions[1].description.type, 'generic');
    if (failedReset.transactions[1].description.type === 'generic') {
        assert.equal(failedReset.transactions[1].description.computePhase.type, 'vm');
        if (failedReset.transactions[1].description.computePhase.type === 'vm') {
            assert.ok(failedReset.transactions[1].description.computePhase.exitCode >= 400 && failedReset.transactions[1].description.computePhase.exitCode < 500);
        }
    }

    // Reset from owner should work
    await counter.sendReset(deployer.getSender(), 10000000n);
    count = await counter.getGetCount();
    assert.equal(count, 0n);

    // Lock from non-owner should throw 401
    const failedLock = await counter.sendLock(attacker.getSender(), 10000000n);
    if (failedLock.transactions[1].description.type === 'generic' && failedLock.transactions[1].description.computePhase.type === 'vm') {
        assert.ok(failedLock.transactions[1].description.computePhase.exitCode >= 400 && failedLock.transactions[1].description.computePhase.exitCode < 500);
    }

    // Lock from owner should transition to Locked
    await counter.sendLock(deployer.getSender(), 10000000n);

    // Increment in Locked state should reject (throw 500)
    const failedInc = await counter.sendIncrement(deployer.getSender(), 10000000n);
    if (failedInc.transactions[1].description.type === 'generic' && failedInc.transactions[1].description.computePhase.type === 'vm') {
        assert.ok(failedInc.transactions[1].description.computePhase.exitCode >= 500 && failedInc.transactions[1].description.computePhase.exitCode < 600);
    }

    // Unlock from owner should transition to Active
    await counter.sendUnlock(deployer.getSender(), 10000000n);
    
    // Now Increment works again
    await counter.sendIncrement(deployer.getSender(), 10000000n);
    count = await counter.getGetCount();
    assert.equal(count, 1n);
});
