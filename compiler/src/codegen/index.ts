import { compileFunc } from '@ton-community/func-js';
import { lower } from './lower';
import { Program } from '../frontend/ast';

export interface CodegenResult {
    funcSource: string;
    boc: Buffer;
}

export async function compileProgram(program: Program): Promise<CodegenResult> {
    const funcSource = lower(program);
    
    const result = await compileFunc({
        targets: ['main.fc'],
        sources: {
            'main.fc': funcSource,
            'stdlib.fc': STDLIB_CONTENT
        }
    });

    if (result.status === 'error') {
        throw new Error(`FunC compile error: ${result.message}`);
    }

    return {
        funcSource,
        boc: Buffer.from(result.codeBoc, 'base64')
    };
}

const STDLIB_CONTENT = `
forall X -> X ~impure_touch(X x) impure asm "NOP";
int slice_empty?(slice s) asm "SEMPTY";
slice begin_parse(cell c) asm "CTOS";
(slice, slice) ~load_msg_addr(slice s) asm( -> 1 0) "LDMSGADDR";
builder begin_cell() asm "NEWC";
builder store_slice(builder b, slice s) asm "STSLICER";
cell end_cell(builder b) asm "ENDC";
() set_data(cell c) impure asm "c4 POP";
cell get_data() asm "c4 PUSH";
int slice_hash(slice s) asm "HASHSU";
`;
