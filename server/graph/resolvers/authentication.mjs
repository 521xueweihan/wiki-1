import _ from 'lodash-es'
import { generateError, generateSuccess } from '../../helpers/graph.mjs'
import jwt from 'jsonwebtoken'
import ms from 'ms'
import { DateTime } from 'luxon'

export default {
  Query: {
    /**
     * List of API Keys
     */
    async apiKeys (obj, args, context) {
      const keys = await WIKI.db.apiKeys.query().orderBy(['isRevoked', 'name'])
      return keys.map(k => ({
        id: k.id,
        name: k.name,
        keyShort: '...' + k.key.substring(k.key.length - 20),
        isRevoked: k.isRevoked,
        expiration: k.expiration,
        createdAt: k.createdAt,
        updatedAt: k.updatedAt
      }))
    },
    /**
     * Current API State
     */
    apiState () {
      return WIKI.config.api.isEnabled
    },
    /**
     * Fetch authentication strategies
     */
    async authStrategies () {
      return WIKI.data.authentication.map(stg => ({
        ...stg,
        isAvailable: stg.isAvailable === true
      }))
    },
    /**
     * Fetch active authentication strategies
     */
    async authActiveStrategies (obj, args, context) {
      const strategies = await WIKI.db.authentication.getStrategies({ enabledOnly: args.enabledOnly })
      return strategies.map(a => {
        const str = _.find(WIKI.data.authentication, ['key', a.module]) || {}
        return {
          ...a,
          config: _.transform(str.props, (r, v, k) => {
            r[k] = v.sensitive ? a.config[k] : '********'
          }, {})
        }
      })
    },
    /**
     * Fetch site authentication strategies
     */
    async authSiteStrategies (obj, args, context, info) {
      const site = await WIKI.db.sites.query().findById(args.siteId)
      const activeStrategies = await WIKI.db.authentication.getStrategies({ enabledOnly: true })
      return activeStrategies.map(str => {
        const siteAuth = _.find(site.config.authStrategies, ['id', str.id]) || {}
        return {
          id: str.id,
          activeStrategy: str,
          order: siteAuth.order ?? 0,
          isVisible: siteAuth.isVisible ?? false
        }
      })
    }
  },
  Mutation: {
    /**
     * Create New API Key
     */
    async createApiKey (obj, args, context) {
      try {
        const key = await WIKI.db.apiKeys.createNewKey(args)
        await WIKI.auth.reloadApiKeys()
        WIKI.events.outbound.emit('reloadApiKeys')
        return {
          key,
          operation: generateSuccess('API Key created successfully')
        }
      } catch (err) {
        WIKI.logger.warn(err)
        return generateError(err)
      }
    },
    /**
     * Perform Login
     */
    async login (obj, args, context) {
      try {
        const authResult = await WIKI.db.users.login(args, context)
        return {
          ...authResult,
          operation: generateSuccess('Login success')
        }
      } catch (err) {
        // LDAP Debug Flag
        if (args.strategy === 'ldap' && WIKI.config.flags.ldapdebug) {
          WIKI.logger.warn('LDAP LOGIN ERROR (c1): ', err)
        }
        console.error(err)

        return generateError(err)
      }
    },
    /**
     * Perform 2FA Login
     */
    async loginTFA (obj, args, context) {
      try {
        const authResult = await WIKI.db.users.loginTFA(args, context)
        return {
          ...authResult,
          responseResult: generateSuccess('TFA success')
        }
      } catch (err) {
        return generateError(err)
      }
    },
    /**
     * Perform Password Change
     */
    async changePassword (obj, args, context) {
      try {
        const authResult = await WIKI.db.users.loginChangePassword(args, context)
        return {
          ...authResult,
          responseResult: generateSuccess('Password changed successfully')
        }
      } catch (err) {
        return generateError(err)
      }
    },
    /**
     * Perform Forget Password
     */
    async forgotPassword (obj, args, context) {
      try {
        await WIKI.db.users.loginForgotPassword(args, context)
        return {
          responseResult: generateSuccess('Password reset request processed.')
        }
      } catch (err) {
        return generateError(err)
      }
    },
    /**
     * Register a new account
     */
    async register (obj, args, context) {
      try {
        await WIKI.db.users.register({ ...args, verify: true }, context)
        return {
          responseResult: generateSuccess('Registration success')
        }
      } catch (err) {
        return generateError(err)
      }
    },
    /**
     * Refresh Token
     */
    async refreshToken (obj, args, context) {
      try {
        let decoded = {}
        if (!args.token) {
          throw new Error('ERR_MISSING_TOKEN')
        }
        try {
          decoded = jwt.verify(args.token, WIKI.config.auth.certs.public, {
            audience: WIKI.config.auth.audience,
            issuer: 'urn:wiki.js',
            algorithms: ['RS256'],
            ignoreExpiration: true
          })
        } catch (err) {
          throw new Error('ERR_INVALID_TOKEN')
        }
        if (DateTime.utc().minus(ms(WIKI.config.auth.tokenRenewal)) > DateTime.fromSeconds(decoded.exp)) {
          throw new Error('ERR_EXPIRED_TOKEN')
        }
        const newToken = await WIKI.db.users.refreshToken(decoded.id)
        return {
          jwt: newToken.token,
          operation: generateSuccess('Token refreshed successfully')
        }
      } catch (err) {
        return generateError(err)
      }
    },
    /**
     * Set API state
     */
    async setApiState (obj, args, context) {
      try {
        WIKI.config.api.isEnabled = args.enabled
        await WIKI.configSvc.saveToDb(['api'])
        return {
          operation: generateSuccess('API State changed successfully')
        }
      } catch (err) {
        return generateError(err)
      }
    },
    /**
     * Revoke an API key
     */
    async revokeApiKey (obj, args, context) {
      try {
        await WIKI.db.apiKeys.query().findById(args.id).patch({
          isRevoked: true
        })
        await WIKI.auth.reloadApiKeys()
        WIKI.events.outbound.emit('reloadApiKeys')
        return {
          operation: generateSuccess('API Key revoked successfully')
        }
      } catch (err) {
        return generateError(err)
      }
    },
    /**
     * Update Authentication Strategies
     */
    async updateAuthStrategies (obj, args, context) {
      try {
        const previousStrategies = await WIKI.db.authentication.getStrategies()
        for (const str of args.strategies) {
          const newStr = {
            displayName: str.displayName,
            order: str.order,
            isEnabled: str.isEnabled,
            config: _.reduce(str.config, (result, value, key) => {
              _.set(result, `${value.key}`, _.get(JSON.parse(value.value), 'v', null))
              return result
            }, {}),
            selfRegistration: str.selfRegistration,
            domainWhitelist: { v: str.domainWhitelist },
            autoEnrollGroups: { v: str.autoEnrollGroups }
          }

          if (_.some(previousStrategies, ['key', str.key])) {
            await WIKI.db.authentication.query().patch({
              key: str.key,
              strategyKey: str.strategyKey,
              ...newStr
            }).where('key', str.key)
          } else {
            await WIKI.db.authentication.query().insert({
              key: str.key,
              strategyKey: str.strategyKey,
              ...newStr
            })
          }
        }

        for (const str of _.differenceBy(previousStrategies, args.strategies, 'key')) {
          const hasUsers = await WIKI.db.users.query().count('* as total').where({ providerKey: str.key }).first()
          if (_.toSafeInteger(hasUsers.total) > 0) {
            throw new Error(`Cannot delete ${str.displayName} as 1 or more users are still using it.`)
          } else {
            await WIKI.db.authentication.query().delete().where('key', str.key)
          }
        }

        await WIKI.auth.activateStrategies()
        WIKI.events.outbound.emit('reloadAuthStrategies')
        return {
          responseResult: generateSuccess('Strategies updated successfully')
        }
      } catch (err) {
        return generateError(err)
      }
    },
    /**
     * Generate New Authentication Public / Private Key Certificates
     */
    async regenerateCertificates (obj, args, context) {
      try {
        await WIKI.auth.regenerateCertificates()
        return {
          responseResult: generateSuccess('Certificates have been regenerated successfully.')
        }
      } catch (err) {
        return generateError(err)
      }
    },
    /**
     * Reset Guest User
     */
    async resetGuestUser (obj, args, context) {
      try {
        await WIKI.auth.resetGuestUser()
        return {
          responseResult: generateSuccess('Guest user has been reset successfully.')
        }
      } catch (err) {
        return generateError(err)
      }
    }
  },
  AuthenticationActiveStrategy: {
    strategy (obj, args, context) {
      return _.find(WIKI.data.authentication, ['key', obj.module])
    }
  }
}
