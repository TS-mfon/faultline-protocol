export { ProtocolError } from '@faultline/protocol';
import { ProtocolError } from '@faultline/protocol';
export function check(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new ProtocolError(code, message);
}
export function parse<T>(schema: { parse(input: unknown): T }, input: unknown): T {
  try { return schema.parse(input); } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError('INVALID_INPUT', 'Input does not match the protocol schema');
  }
}
