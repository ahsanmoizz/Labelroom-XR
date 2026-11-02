// LABELXR-REVIEW-HTTP-v1
import {requireVerifiedUser,type AuthenticationClient,type VerifiedIdentity} from './auth.ts';
import {HttpProblem,approvedOrigin,checkRequest,jsonResponse,problemResponse,readJsonObject} from './http.ts';
import {reviewCommandSchema,type ReviewCommand} from '../../../src/domain/revision.ts';
import {selectReviewAcknowledgement} from '../../../src/domain/review-ack.ts';
export interface ReviewRpcPort {
 commit(command:ReviewCommand,signal:AbortSignal):Promise<{data:unknown;error:{code?:string}|null}>;
}
/** The adapter must use the verified caller's bearer with a public key,never service-role commit_review. */
export interface ReviewHandlerOptions {
 origin:string;client:AuthenticationClient;
 open(token:string,identity:Readonly<VerifiedIdentity>,signal:AbortSignal):Promise<ReviewRpcPort>;
}
export function createReviewHandler(options:ReviewHandlerOptions){
 const origin=approvedOrigin(options.origin);
 return async(request:Request):Promise<Response>=>{
  const id=crypto.randomUUID();
  try{
   const preflight=checkRequest(request,origin,id);if(preflight)return preflight;
   const authorization=request.headers.get('Authorization'),body=await readJsonObject(request),user=await requireVerifiedUser(request,options.client);
   if(request.signal.aborted||authorization!==request.headers.get('Authorization'))throw new HttpProblem('authentication');
   const token=/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization??'')?.[1];if(!token)throw new HttpProblem('authentication');
   const parsed=reviewCommandSchema.safeParse(body);if(!parsed.success||new TextEncoder().encode(JSON.stringify(parsed.data)).length>16384)throw new HttpProblem('projectInput');
   const command=parsed.data;let result:Awaited<ReturnType<ReviewRpcPort['commit']>>;
   try{const port=await options.open(token,user,request.signal);if(request.signal.aborted)throw new HttpProblem('authentication');result=await port.commit(command,request.signal)}
   catch(error){if(error instanceof HttpProblem)throw error;throw new HttpProblem('projectUnavailable')}
   if(!result||result.error){const code=result?.error?.code;throw new HttpProblem(code==='42501'?'projectAccess':code==='40001'||code==='23514'?'projectConflict':code==='22023'?'projectInput':'projectUnavailable')}
   if(request.signal.aborted)throw new HttpProblem('projectUnavailable');
   let acknowledgement;try{acknowledgement=selectReviewAcknowledgement(result.data,command)}catch{throw new HttpProblem('projectData')}
   return jsonResponse(request,origin,id,acknowledgement);
  }catch(error){return problemResponse(request,origin,id,error)}
 };
}
