import {hashCanonical,type EvidenceSnapshot,type Operation,type WorkflowRecord} from '@faultline/protocol';
import {replay,scenarios} from '@faultline/examples';
import type {Domain,Evidence} from './model';
export const templates:Record<Domain,{title:string;description:string;nodes:string[];impact:string;repair:string;source:string}>=Object.fromEntries(Object.entries(scenarios).map(([domain,s])=>[domain,{title:s.title,description:s.specs[0],nodes:['Produce source analysis','Review and contain','Publish approved result'],impact:'A defect in the upstream artifact passed an explicit detection duty and propagated to publication.',repair:s.repair,source:s.source}])) as any;
export type Replay={snapshot:EvidenceSnapshot;workflow:WorkflowRecord;evidence:Evidence[];operations:Operation[]};
export function makeReplay(domain:Domain):Replay{
 const r=replay(domain),m=r.manifest;
 return {snapshot:r.snapshot,evidence:r.snapshot.evidence,workflow:{manifest:m,hash:hashCanonical(m),mode:'replay',status:'repairing',createdAt:'2026-10-15T09:00:00Z',expiresAt:'2026-10-22T09:00:00Z',accepted:m.nodes.map(n=>n.agent),bonded:{...m.bonds},handoffs:r.snapshot.handoffs,acknowledgments:r.snapshot.acknowledgments,suspendedNodes:['review','publish'],revision:1,caseId:r.snapshot.caseId,evidenceRound:1,decision:r.decision},operations:[{id:`replay-${domain}-decision`,kind:'adjudicate',status:'completed',workflowId:m.id,createdAt:'2026-10-15T10:00:00Z',updatedAt:'2026-10-15T10:00:00Z',result:{mode:'replay',note:'Authored illustrative decision; no chain transaction.'}}]};
}
export const localReplays=(['software','research','procurement'] as const).map(makeReplay);
