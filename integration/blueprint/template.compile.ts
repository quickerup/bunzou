// Not implemented. This will mirror tolk-js's call shape once codegen
// (compiler/src/codegen/) exists — see architecture.md §2 stage 8 and §4
// step 6. Until then this file is a placeholder for the intended interface:
//
//   import { runBunzouCompiler } from '@bunzou/compiler';
//
//   export default async function compile() {
//     const result = await runBunzouCompiler({
//       entrypoint: 'contracts/counter.bunzou',
//     });
//     // result: { status, fiftCode, codeBoc64, codeHashHex }
//     return Cell.fromBoc(Buffer.from(result.codeBoc64, 'base64'))[0];
//   }
