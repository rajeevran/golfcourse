var { UserSchema } =require('../schema/api')
var fs = require('fs')

class UserBusiness {
  /**
   * create a new user
   * @param  {Object} data user data
   * @return {Promise}
   */
  static create(data) {
    var newUser = new UserSchema(data);
    return newUser.save().then((user) => {
      //fire event to another sides
    console.log('user--->',user)
    return user
    });
  }

  /**
   * update user
   * @param  {Object} Mongoose user object
   * @return {Promise}
   */
  static update(user) {
    return user.save().then((updated) => {
     
    });
  }

  /**
   * Update all data by query
   * @param  {Object} data user data
   * @return {Promise}
   */
  static updateByQuery(params) {
    //TODO - code me
    let promise = new Promise((resolve, reject) => {
      resolve(true);
    });

    return Promise;
  }

  /**
   * find list of users
   * @param  {Object} params Mongo query
   * @return {Promise}
   */
  static find(params) {
    console.log('find hitted');
    
    var ObjectId = require('mongoose').Types.ObjectId;
    var condition = {};
    var limit = 0;
    var sort = 'createdAt';
    var order = -1;
    if(params._id !== undefined){
      console.log('params._id hitted',params._id);

      condition = {
      _id: {$eq: new ObjectId(params._id)}
      }
    }

    if(typeof params.sort != 'undefined'){
        sort = params.sort;
    }
    if(typeof params.order != 'undefined'){
      order = params.order;
    }
    if(params.status=='active'){
        condition.status = params.status;
    }
    if(typeof params.keyword != 'undefined' && params.sort != null){
      var regex = new RegExp(params.keyword, "i")
      condition = {'$or':[{name : regex},{email : regex}]};
    }
    if(params.limit !== 'undefined'){
      var filter = { sortCheck : order};
      filter[sort] = filter.sortCheck;
      delete filter.sortCheck;
      limit =   params.limit;
      return UserSchema.find(condition).sort(filter).skip(params.offset*limit).limit(params.limit).exec();
    }else{
      return UserSchema.find(condition).count().exec();
    }

  }

  /**
   * find single record by params
   * @param  {Object} params Mongo query
   * @return {Promise}
   */
  static findOne(params) {    
    return UserSchema.findOne(params).exec();
  }

  static findOneByAdmin(params) {
    return UserSchema.findOne(params).exec();
  }

  static forgotPassword(params,newPass) {
    console.log('business newPass---',newPass)
    console.log('business params---',params)
    return UserSchema.findOne(params, '-salt -password -socialLogin, -otp').exec().then((user) => {
    console.log('business user---',user)
    user.password = newPass;
    user.otp = "";

         UserBusiness.update(user)
          .then((user) => {

          });
          return user;
    });
  }

  /**
   * delete account & fire delete event
   * @param  {String} id
   * @return {Promise}
   */
  static delete(id) {
    return UserSchema.findByIdAndRemove(id).exec()
    .then(() => {

      return true;
    });
  }
  /**
   * Unlink all data by query
   * @param  {Object} data user data
   * @return {Promise}
   */
  static unlinkFile(params) {
    //TODO - code me
    let promise = new Promise((resolve, reject) => {

      let filePath = `./public/${params}`;
      fs.unlink(filePath, (err) => {
          if (err) {
              console.log('err', err);
              reject(err)
          } else {
              console.log(params + ' was deleted');
              resolve(params + ' was deleted');

          }
      });
    });

    return promise;
  }
}

module.exports = UserBusiness;
