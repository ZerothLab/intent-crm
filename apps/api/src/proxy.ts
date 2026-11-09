import { BlockList, isIP } from 'node:net';

const mappedIPv4 = new BlockList();
mappedIPv4.addSubnet('::ffff:0:0', 96, 'ipv6');

export function trustedProxies(value = process.env.INTENT_TRUSTED_PROXIES): false | string[] {
    if (!value?.trim()) return false;
    const addresses = value.split(',').map(address => address.trim());
    if (addresses.length > 100 || addresses.some(address => {
        const [ip, prefix, extra] = address.split('/');
        const family = isIP(ip ?? '');
        return !family || ip!.includes('%') || extra !== undefined || (family === 6 && prefix !== undefined && mappedIPv4.check(ip!, 'ipv6')) || (prefix !== undefined &&
            (!/^[1-9]\d*$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)));
    })) throw new Error('INTENT_TRUSTED_PROXIES must contain explicit proxy IP addresses or CIDR ranges, separated by commas. Trust-all ranges are not allowed; use IPv4 notation for IPv4-mapped CIDRs.');
    return addresses;
}
