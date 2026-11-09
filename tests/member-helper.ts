import type { Actor, Member, Role } from '../packages/contracts/src/index.js';
import type { IntentService } from '../packages/domain/src/index.js';

export async function updateMember(service: IntentService, actor: Actor, id: string, input: { name: string; email: string; role: Role; active: boolean }): Promise<Member> {
    const current = (await service.listMembers(actor)).find(member => member.id === id)!;
    return service.updateMember(actor, id, { ...input, expectedRevision: current.revision });
}
