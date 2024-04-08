import config from './config.js'

/**
 * Get a list of own IPFS nodes from the config file
 */
export function getNodesList(excludedMultiaddrs = []) {
    return config.nodes
        .map(node => node.multiaddr)
        .filter(multiaddr => !excludedMultiaddrs.includes(multiaddr))
}
