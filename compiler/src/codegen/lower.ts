import { Program, StateDecl, StructDecl, BehaviorDecl, GetMethodDecl, Stmt, Expr, OnHandler } from '../frontend/ast';
import { crc32 } from './crc32';

export class CodegenError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CodegenError';
    }
}

export function lower(program: Program): string {
    let out = '';
    
    // 1. Find StateDecl and StructDecl
    const stateDecls = program.decls.filter((d): d is StateDecl => d.kind === 'StateDecl');
    if (stateDecls.length !== 1) {
        throw new CodegenError('Program must have exactly one StateDecl');
    }
    const stateDecl = stateDecls[0];
    
    const structDecls = program.decls.filter((d): d is StructDecl => d.kind === 'StructDecl');
    
    // Check all variants share the same payload type
    const payloadTypes = new Set<string>();
    stateDecl.variants.forEach(v => {
        if (!v.payloadType) throw new CodegenError(`Variant ${v.name} missing payload type`);
        payloadTypes.add(v.payloadType);
    });
    if (payloadTypes.size !== 1) {
        throw new CodegenError('All variants must share the same payload struct shape for now');
    }
    const payloadType = Array.from(payloadTypes)[0];
    const structDecl = structDecls.find(s => s.name === payloadType);
    if (!structDecl) {
        throw new CodegenError(`Struct ${payloadType} not found`);
    }

    const tagBits = Math.max(1, Math.ceil(Math.log2(stateDecl.variants.length)));

    // Emit helper functions
    out += `#pragma version >=0.4.0;
#include "stdlib.fc";

int equal_slices(slice a, slice b) inline {
    return a.slice_hash() == b.slice_hash();
}
`;

    // Emit load_data
    out += `
(int, int, slice) load_data() inline {
    slice cs = get_data().begin_parse();
    int tag = cs~load_uint(${tagBits});
`;
    // We hardcode the fields for now, but we can generate them from structDecl
    const loadFields: string[] = [];
    const saveFields: string[] = [];
    const varDecls: string[] = [];
    
    structDecl.fields.forEach(f => {
        if (f.type === 'uint64') {
            loadFields.push(`    int ${f.name} = cs~load_uint(64);`);
            saveFields.push(`        .store_uint(${f.name}, 64)`);
            varDecls.push(`int ${f.name}`);
        } else if (f.type === 'addr') {
            loadFields.push(`    slice ${f.name} = cs~load_msg_addr();`);
            saveFields.push(`        .store_slice(${f.name})`);
            varDecls.push(`slice ${f.name}`);
        } else if (f.type === 'bool') {
            loadFields.push(`    int ${f.name} = cs~load_uint(1);`);
            saveFields.push(`        .store_uint(${f.name}, 1)`);
            varDecls.push(`int ${f.name}`);
        } else {
            throw new CodegenError(`Unsupported field type: ${f.type}`);
        }
    });
    
    out += loadFields.join('\n') + '\n';
    out += `    return (tag, ${structDecl.fields.map(f => f.name).join(', ')});\n}\n\n`;
    
    // Emit save_data
    out += `() save_data(int tag, ${varDecls.join(', ')}) impure inline {
    set_data(begin_cell()
        .store_uint(tag, ${tagBits})
${saveFields.join('\n')}
    .end_cell());
}
\n`;

    // Emit recv_internal
    out += `() recv_internal(int msg_value, cell in_msg_full, slice in_msg_body) impure {
    if (in_msg_body.slice_empty?()) {
        return ();
    }
    slice cs = in_msg_full.begin_parse();
    int flags = cs~load_uint(4);
    if (flags & 1) {
        return ();
    }
    slice sender = cs~load_msg_addr();
    int op = in_msg_body~load_uint(32);
    
    (int state_tag, ${varDecls.join(', ')}) = load_data();
`;

    // Process behaviors
    const behaviors = program.decls.filter((d): d is BehaviorDecl => d.kind === 'BehaviorDecl');
    // Sort behaviors to match StateDecl variant order
    behaviors.sort((a, b) => {
        const idxA = stateDecl.variants.findIndex(v => v.name === a.stateVariant);
        const idxB = stateDecl.variants.findIndex(v => v.name === b.stateVariant);
        return idxA - idxB;
    });

    let exitCodeRequire = 400;
    let exitCodeReject = 500;

    for (let i = 0; i < behaviors.length; i++) {
        const b = behaviors[i];
        const variantIdx = stateDecl.variants.findIndex(v => v.name === b.stateVariant);
        const isLast = i === behaviors.length - 1;
        
        if (i === 0) out += `    if (state_tag == ${variantIdx}) {\n`;
        else if (isLast) out += `    } else {\n`;
        else out += `    } elseif (state_tag == ${variantIdx}) {\n`;

        for (let j = 0; j < b.handlers.length; j++) {
            const h = b.handlers[j];
            const opCode = crc32(h.message);
            if (j === 0) out += `        if (op == ${opCode}) { ;; ${h.message}\n`;
            else out += `        } elseif (op == ${opCode}) { ;; ${h.message}\n`;

            // lower body
            const ctx = { exitCodeRequire, exitCodeReject, returnTagIdx: stateDecl.variants.findIndex(v => v.name === h.returnType), structDecl };
            out += lowerStmts(h.body, ctx, 12);
            exitCodeRequire = ctx.exitCodeRequire;
            exitCodeReject = ctx.exitCodeReject;
        }
        if (b.handlers.length > 0) {
            out += `        } else {\n            throw(0xffff);\n        }\n`;
        }
    }
    
    if (behaviors.length > 0) {
        out += `    }\n`;
    }
    out += `}\n\n`;

    // Process get methods
    const getMethods = program.decls.filter((d): d is GetMethodDecl => d.kind === 'GetMethodDecl');
    for (const gm of getMethods) {
        out += `int ${gm.name}() method_id {\n`;
        out += `    (int state_tag, ${varDecls.join(', ')}) = load_data();\n`;
        out += lowerStmts(gm.body, { exitCodeRequire: 400, exitCodeReject: 500, returnTagIdx: -1, structDecl }, 4);
        out += `}\n\n`;
    }

    return out;
}

function lowerStmts(stmts: Stmt[], ctx: any, indent: number): string {
    let out = '';
    const pad = ' '.repeat(indent);
    for (const stmt of stmts) {
        if (stmt.kind === 'ExprStmt') {
            const expr = stmt.expr;
            if (expr.kind === 'Call' && expr.callee.kind === 'Ident' && expr.callee.name === 'consume') {
                // no-op
            } else if (expr.kind === 'Call' && expr.callee.kind === 'Ident' && expr.callee.name === 'require') {
                const cond = lowerExpr(expr.args[0], ctx);
                out += `${pad}throw_unless(${ctx.exitCodeRequire++}, ${cond});\n`;
            } else if (expr.kind === 'Call' && expr.callee.kind === 'Ident' && expr.callee.name === 'reject') {
                out += `${pad}throw(${ctx.exitCodeReject++});\n`;
            } else {
                throw new CodegenError(`Unsupported expr stmt: ${JSON.stringify(expr)}`);
            }
        } else if (stmt.kind === 'IfStmt') {
            const cond = lowerExpr(stmt.cond, ctx);
            out += `${pad}if (${cond}) {\n`;
            out += lowerStmts(stmt.thenBranch, ctx, indent + 4);
            if (stmt.elseBranch) {
                out += `${pad}} else {\n`;
                out += lowerStmts(stmt.elseBranch, ctx, indent + 4);
            }
            out += `${pad}}\n`;
        } else if (stmt.kind === 'ReturnStmt') {
            if (ctx.returnTagIdx === -1) {
                // Get method return
                out += `${pad}return ${lowerExpr(stmt.value, ctx)};\n`;
            } else {
                // Handler return
                const val = stmt.value;
                if (val.kind === 'SelfExpr') {
                    // return self
                    const args = ctx.structDecl.fields.map((f: any) => f.name).join(', ');
                    out += `${pad}save_data(${ctx.returnTagIdx}, ${args});\n`;
                    out += `${pad}return ();\n`;
                } else if (val.kind === 'Call') {
                    // return Active(...)
                    const arg = val.args[0];
                    if (arg.kind === 'SelfExpr') {
                        const args = ctx.structDecl.fields.map((f: any) => f.name).join(', ');
                        out += `${pad}save_data(${ctx.returnTagIdx}, ${args});\n`;
                        out += `${pad}return ();\n`;
                    } else if (arg.kind === 'StructLit') {
                        // resolve fields
                        const args = ctx.structDecl.fields.map((f: any) => {
                            const field = arg.fields.find((af: any) => af.name === f.name);
                            if (!field) throw new CodegenError(`Missing field ${f.name} in struct literal`);
                            return lowerExpr(field.value, ctx);
                        });
                        out += `${pad}save_data(${ctx.returnTagIdx}, ${args.join(', ')});\n`;
                        out += `${pad}return ();\n`;
                    } else {
                         throw new CodegenError(`Unsupported return argument: ${arg.kind}`);
                    }
                } else {
                    throw new CodegenError(`Unsupported return value: ${val.kind}`);
                }
            }
        }
    }
    return out;
}

function lowerExpr(expr: Expr, ctx: any): string {
    if (expr.kind === 'Ident') {
        throw new CodegenError(`Unsupported bare ident: ${expr.name}`);
    } else if (expr.kind === 'SelfExpr') {
        throw new CodegenError('Bare self not allowed here');
    } else if (expr.kind === 'FieldAccess') {
        if (expr.object.kind === 'SelfExpr') {
            return expr.field; // field becomes local variable
        } else if (expr.object.kind === 'Ident' && expr.field === 'sender') {
            return 'sender';
        }
        throw new CodegenError('Unsupported field access');
    } else if (expr.kind === 'BinaryOp') {
        let op = expr.op;
        if (op === '&&') op = '&';
        if (op === '||') op = '|';
        
        if ((op === '==' || op === '!=') && isSlice(expr.left, ctx) && isSlice(expr.right, ctx)) {
            const func = op === '==' ? 'equal_slices' : '~ equal_slices';
            return `${func}(${lowerExpr(expr.left, ctx)}, ${lowerExpr(expr.right, ctx)})`;
        }
        
        return `(${lowerExpr(expr.left, ctx)} ${op} ${lowerExpr(expr.right, ctx)})`;
    } else if (expr.kind === 'NumberLit') {
        return expr.value.toString();
    }
    throw new CodegenError(`Unsupported expression: ${expr.kind}`);
}

function isSlice(expr: Expr, ctx: any): boolean {
    if (expr.kind === 'FieldAccess') {
        if (expr.object.kind === 'SelfExpr') {
            const f = ctx.structDecl.fields.find((f: any) => f.name === expr.field);
            return f?.type === 'addr';
        } else if (expr.object.kind === 'Ident' && expr.field === 'sender') {
            return true;
        }
    }
    return false;
}
