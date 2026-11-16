/** Build a module entry without interpreting platform path separators as JS escapes. */
export function browserModuleSource(file) {
 return 'export {mountAgentPanel} from '+JSON.stringify(file)+';';
}
