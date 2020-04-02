'use strict'

const { pick } = require('lodash')
const {
  decorate,
  injectable,
  inject
} = require('inversify')
const {
  AuthError
} = require('bfx-report/workers/loc.api/errors')

const TYPES = require('../../di/types')
const { serializeVal } = require('../dao/helpers')
const { isSubAccountApiKeys } = require('../../helpers')

class Authenticator {
  constructor (
    dao,
    TABLES_NAMES,
    rService,
    crypto
  ) {
    this.dao = dao
    this.TABLES_NAMES = TABLES_NAMES
    this.rService = rService
    this.crypto = crypto

    this.secretKey = this.crypto.getSecretKey()

    this.passRegEx = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[a-zA-Z\d]{8,}$/

    /**
     * It may only work for one grenache worker instance
     */
    this.userSessions = new Map()
  }

  /**
   * It creates user entry
   *
   * @return { Promise<object> }
   * Return an object { jsonWebToken, email }
   * where jsonWebToken payload is
   * an object { _id, email, encryptedPassword }
   */
  async signUp (args, params) {
    const { auth } = { ...args }
    const { apiKey, apiSecret, password } = { ...auth }
    const {
      active = true,
      isDataFromDb = true
    } = { ...params }

    if (
      !apiKey ||
      typeof apiKey !== 'string' ||
      !apiSecret ||
      typeof apiSecret !== 'string' ||
      !password ||
      typeof password !== 'string' ||
      !this.isSecurePassword(password) ||
      isSubAccountApiKeys({ apiKey, apiSecret })
    ) {
      throw new AuthError()
    }

    const {
      email,
      timezone,
      username,
      id
    } = await this.rService._checkAuthInApi(args)
    const userFromDb = await this.getUser(
      { email },
      { isNotSubAccount: true }
    )

    if (
      !email ||
      typeof email !== 'string' ||
      (
        userFromDb &&
        typeof userFromDb === 'object' &&
        Number.isInteger(userFromDb._id)
      )
    ) {
      throw new AuthError()
    }

    const [
      encryptedApiKey,
      encryptedApiSecret,
      encryptedPassword,
      passwordHash
    ] = await Promise.all([
      this.crypto.encrypt(apiKey, password),
      this.crypto.encrypt(apiSecret, password),
      this.crypto.encrypt(password, this.secretKey),
      this.crypto.hashPassword(password)
    ])

    const { _id, isSubAccount } = await this.createUser({
      email,
      timezone,
      username,
      id,
      apiKey: encryptedApiKey,
      apiSecret: encryptedApiSecret,
      active: serializeVal(active),
      isDataFromDb: serializeVal(isDataFromDb),
      passwordHash
    })

    const payload = { _id, email, encryptedPassword }
    const jwt = await this.generateAuthJWT(payload)

    this.setUserSession({ _id, email, jwt })

    return { email, isSubAccount, jwt }
  }

  async signIn (args, params) {
    const { auth } = { ...args }
    const {
      email,
      password,
      isSubAccount,
      jwt
    } = { ...auth }
    const {
      active = true,
      isDataFromDb = true
    } = { ...params }

    const user = await this.verifyUser(
      {
        auth: {
          email,
          password,
          isSubAccount,
          jwt
        }
      },
      {
        isDecryptedApiKeys: true,
        isReturnedPassword: true
      }
    )
    const {
      _id,
      email: emailFromDb,
      isSubAccount: isSubAccountFromDb,
      apiKey,
      apiSecret,
      password: decryptedPassword
    } = { ...user }

    const {
      id,
      timezone,
      username,
      email: emailFromApi
    } = await this.rService._checkAuthInApi({
      auth: { apiKey, apiSecret }
    })

    const res = await this.dao.updateCollBy(
      this.TABLES_NAMES.USERS,
      { _id, email: emailFromDb },
      {
        id,
        timezone,
        username,
        email: emailFromApi,
        active: serializeVal(active),
        isDataFromDb: serializeVal(isDataFromDb)
      }
    )

    if (res && res.changes < 1) {
      throw new AuthError()
    }

    const freshEmail = (
      (email && typeof email === 'string') ||
      emailFromApi !== emailFromDb
    )
      ? emailFromApi
      : null
    const payload = {
      _id,
      email: freshEmail,
      password: decryptedPassword,
      jwt
    }
    const resJWT = await this.generateAuthJWT(payload)

    this.setUserSession(
      { _id, email: emailFromApi, jwt: resJWT }
    )

    return {
      email: emailFromApi,
      isSubAccount: isSubAccountFromDb,
      jwt: resJWT
    }
  }

  async signOut (args, params) {
    const { auth } = { ...args }
    const {
      email,
      password,
      isSubAccount,
      jwt
    } = { ...auth }
    const { active = false } = { ...params }

    const user = await this.verifyUser(
      {
        auth: {
          email,
          password,
          isSubAccount,
          jwt
        }
      }
    )
    const { _id, email: emailFromDb } = { ...user }

    const res = await this.dao.updateCollBy(
      this.TABLES_NAMES.USERS,
      { _id, email: emailFromDb },
      { active: serializeVal(active) }
    )

    if (res && res.changes < 1) {
      throw new AuthError()
    }

    this.removeUserSessionById(_id)

    return true
  }

  async verifyUser (args, params) {
    const { auth } = { ...args }
    const {
      email,
      password,
      isSubAccount,
      jwt
    } = { ...auth }
    const {
      projection,
      isFilledSubUsers,
      isDecryptedApiKeys,
      isReturnedPassword
    } = { ...params }

    if (
      email &&
      typeof email === 'string' &&
      password &&
      typeof password === 'string'
    ) {
      const pwdParam = isDecryptedApiKeys
        ? { password }
        : {}
      const _user = await this.getUser(
        { email },
        {
          isNotSubAccount: !isSubAccount,
          isSubAccount,
          isFilledSubUsers,
          ...pwdParam
        }
      )
      const { passwordHash } = { ..._user }
      const user = this.excludeProps(_user, projection)

      await this.crypto.verifyPassword(
        password,
        passwordHash
      )

      return {
        ...user,
        password: isReturnedPassword ? password : null
      }
    }
    if (
      jwt &&
      typeof jwt === 'string'
    ) {
      const {
        _id,
        email: emailFromJWT,
        encryptedPassword
      } = await this.crypto.verifyJWT(jwt)
      const decryptedPassword = await this.crypto.decrypt(
        encryptedPassword,
        this.secretKey
      )
      const pwdParam = isDecryptedApiKeys
        ? { password: decryptedPassword }
        : {}
      const _user = await this.getUser(
        { _id, email: emailFromJWT },
        {
          isFilledSubUsers,
          ...pwdParam
        }
      )
      const { passwordHash } = { ..._user }

      await this.crypto.verifyPassword(
        decryptedPassword,
        passwordHash
      )

      const user = {
        ..._user,
        password: isReturnedPassword ? decryptedPassword : null
      }
      return this.excludeProps(user, projection)
    }

    throw new AuthError()
  }

  async getUser (filter, params) {
    const {
      isFilledSubUsers,
      projection,
      password
    } = { ...params }

    const _user = await this.dao.getUser(filter, params)
    const user = this.excludeProps(_user, projection)

    if (
      !password ||
      typeof password !== 'string'
    ) {
      return user
    }

    const decryptedUser = await this
      .decryptApiKeys(password, user)

    if (!isFilledSubUsers) {
      return decryptedUser
    }

    const { subUsers } = { ...decryptedUser }

    const decryptedSubUsers = await this
      .decryptApiKeys(password, subUsers)

    return {
      ...decryptedUser,
      subUsers: decryptedSubUsers
    }
  }

  async getUsers (filter, params) {
    const {
      isFilledSubUsers,
      password,
      emailPasswordsMap,
      projection
    } = { ...params }
    const _emailPasswordsMap = Array.isArray(emailPasswordsMap)
      ? emailPasswordsMap
      : [emailPasswordsMap]
    const filteredEmailPwdsMap = _emailPasswordsMap
      .filter((emailPwd) => {
        const { password, email } = { ...emailPwd }

        return (
          password &&
          typeof password === 'string' &&
          email &&
          typeof email === 'string'
        )
      })

    const _users = await this.dao.getUsers(filter, params)
    const users = this.excludeProps(_users, projection)

    if (
      !password ||
      typeof password !== 'string'
    ) {
      return users
    }

    const decryptedUsers = await this
      .decryptApiKeys(password, users)

    if (!isFilledSubUsers) {
      return decryptedUsers
    }

    const promises = decryptedUsers.map((user) => {
      const { subUsers, email } = { ...user }
      const { password } = filteredEmailPwdsMap
        .find(({ email: pwdEmail }) => pwdEmail === email)

      return this.decryptApiKeys(password, subUsers)
    })
    const decryptedSubUsers = await Promise.all(promises)

    return decryptedUsers.map((user, i) => {
      return {
        ...user,
        subUsers: decryptedSubUsers[i]
      }
    })
  }

  excludeProps (data, props) {
    if (
      !Array.isArray(props) ||
      props.length === 0
    ) {
      return data
    }

    const isArray = Array.isArray(data)
    const dataArr = isArray ? data : [data]

    const res = dataArr.map((item) => {
      if (!item || typeof item !== 'object') {
        return item
      }

      return pick(item, props)
    })

    return isArray ? res : res[0]
  }

  async createUser (data) {
    const { email } = { ...data }

    await this.dao.insertElemsToDb(
      this.TABLES_NAMES.USERS,
      null,
      [data]
    )
    const user = await this.getUser(
      { email },
      { isNotSubAccount: true }
    )

    if (
      !user ||
      typeof user !== 'object' ||
      !Number.isInteger(user._id)
    ) {
      throw new AuthError()
    }

    return user
  }

  setUserSession (data) {
    const { _id, email, jwt } = { ...data }

    this.userSessions.set(_id, { _id, email, jwt })
  }

  async getUserSessionById (id, params) {
    const { isFilledUsers } = { ...params }
    const userSession = this.userSessions.get(id)
    const { jwt } = { ...userSession }

    if (isFilledUsers && jwt) {
      const user = await this.verifyUser(
        { auth: { jwt } },
        { isDecryptedApiKeys: true }
      )

      return { ...userSession, ...user, jwt }
    }

    return userSession && typeof userSession === 'object'
      ? { ...userSession }
      : userSession
  }

  async getUserSessions (params) {
    const { isFilledUsers } = { ...params }

    const userSessionsPromises = [...this.userSessions]
      .map(async ([id, session]) => {
        const { jwt } = { ...session }

        if (isFilledUsers && jwt) {
          const user = await this.verifyUser(
            { auth: { jwt } },
            { isDecryptedApiKeys: true }
          )

          return [id, { ...session, ...user, jwt }]
        }

        const userSession = session && typeof session === 'object'
          ? { ...session }
          : session

        return [id, userSession]
      })
    const userSessions = await Promise.all(userSessionsPromises)

    return new Map(userSessions)
  }

  removeUserSessionById (id) {
    return this.userSessions.delete(id)
  }

  async generateAuthJWT (payload) {
    const {
      _id,
      email,
      encryptedPassword,
      password,
      jwt
    } = { ...payload }
    if (
      email &&
      typeof email === 'string'
    ) {
      if (
        encryptedPassword &&
        typeof encryptedPassword === 'string'
      ) {
        const payload = { _id, email, encryptedPassword }

        return this.crypto.generateJWT(payload)
      }
      if (
        password &&
        typeof password === 'string'
      ) {
        const encryptedPassword = await this.crypto.encrypt(
          password,
          this.secretKey
        )
        const payload = { _id, email, encryptedPassword }

        return this.crypto.generateJWT(payload)
      }

      throw new AuthError()
    }
    if (
      jwt &&
      typeof jwt === 'string'
    ) {
      return jwt
    }

    throw new AuthError()
  }

  async decryptApiKeys (password, users) {
    const isArray = Array.isArray(users)
    const _users = isArray ? users : [users]

    const promises = _users.reduce((accum, user) => {
      const { apiKey, apiSecret } = { ...user }

      return [
        ...accum,
        this.crypto.decrypt(apiKey, password),
        this.crypto.decrypt(apiSecret, password)
      ]
    }, [])
    const decryptedApiKeys = await Promise.all(promises)

    const res = _users.map((user, i) => {
      const apiKey = decryptedApiKeys[i * 2]
      const apiSecret = decryptedApiKeys[i * 2 + 1]

      return {
        ...user,
        apiKey,
        apiSecret
      }
    })

    return isArray ? res : res[0]
  }

  isSecurePassword (password) {
    return this.passRegEx.test(password)
  }
}

decorate(injectable(), Authenticator)
decorate(inject(TYPES.DAO), Authenticator, 0)
decorate(inject(TYPES.TABLES_NAMES), Authenticator, 1)
decorate(inject(TYPES.RService), Authenticator, 2)
decorate(inject(TYPES.Crypto), Authenticator, 3)

module.exports = Authenticator