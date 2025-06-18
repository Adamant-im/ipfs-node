import swaggerJSDoc from 'swagger-jsdoc'

const options: swaggerJSDoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'IPFS node API specification',
      version: '0.1.0',
      description: 'API specification for IPFS node REST API'
    },
    servers: [
      {
        url: 'https://ipfs4.adm.im',
        description: 'IPFS node ADAMANT server #4'
      },
      {
        url: 'https://ipfs5.adamant.im',
        description: 'IPFS node ADAMANT server #5'
      },
      {
        url: 'https://ipfs6.adamant.business',
        description: 'IPFS node ADAMANT server #6'
      },
      {
        url: 'http://localhost:4000',
        description: 'Local server'
      }
    ],
    basePath: '/api'
  },
  apis: ['./src/api/routes/*.ts']
}

export const swaggerSpec = swaggerJSDoc(options)
